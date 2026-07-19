# syntax=docker/dockerfile:1

# ---------- Stage 1: dependencies ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Full dependency tree, including devDependencies needed to compile.
RUN npm ci

# ---------- Stage 2: build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

# ---------- Stage 3: production dependencies ----------
# `prisma` (the CLI) is a runtime dependency, not a dev one: the image must be
# able to run `prisma migrate deploy` and generate its own client without
# reaching out to the network.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# ---------- Stage 4: runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# openssl is required by Prisma's query engine on Debian slim images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ship only what runtime needs: compiled JS, production node_modules, and the
# Prisma schema/migrations (so the container can run `migrate deploy`).
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node package.json ./

# `node` is a non-root user that ships with the official image.
USER node

EXPOSE 3000

# Overridden per service in docker-compose.yml (gateway vs worker).
CMD ["node", "dist/main.js"]
