#!/usr/bin/env bash
#
# Runs a test tier against isolated Postgres and Redis containers.
#
#   ./scripts/test-stack.sh integration   # integration tier only
#   ./scripts/test-stack.sh e2e           # end-to-end tier only
#   ./scripts/test-stack.sh all           # unit + integration + e2e (default)
#
# Everything is self-contained: containers are created, migrated, used, and
# destroyed here. Local dev data is never touched — the test stack uses its own
# compose project, its own ports, and tmpfs storage.

set -euo pipefail

cd "$(dirname "$0")/.."

TIER="${1:-all}"

COMPOSE_PROJECT="cortist-test"
COMPOSE_FILE="docker-compose.test.yml"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")

# Keep the containers around after a run with KEEP_TEST_STACK=1 (useful when
# iterating on a failing test).
KEEP_TEST_STACK="${KEEP_TEST_STACK:-0}"

cleanup() {
  local exit_code=$?
  if [[ "$KEEP_TEST_STACK" == "1" ]]; then
    echo "==> KEEP_TEST_STACK=1 — leaving the test stack running."
    echo "    Tear down with: ${COMPOSE[*]} down -v"
  else
    echo "==> Tearing down the test stack"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "==> Starting isolated Postgres and Redis"
# --wait blocks on the healthchecks declared in the compose file, so both
# services are accepting connections once this returns.
"${COMPOSE[@]}" up -d --wait

echo "==> Applying database migrations"
set -a
# shellcheck disable=SC1091
source .env.test
set +a
npx prisma migrate deploy

echo "==> Generating the Prisma client"
npx prisma generate

if [[ "$TIER" == "all" ]]; then
  echo "==> Running unit tests"
  npx jest --config jest.config.js
fi

if [[ "$TIER" == "all" || "$TIER" == "integration" ]]; then
  echo "==> Running integration tests"
  npx jest --config jest.integration.config.js --runInBand --forceExit
fi

if [[ "$TIER" == "all" || "$TIER" == "e2e" ]]; then
  echo "==> Running end-to-end tests"
  npx jest --config jest.e2e.config.js --runInBand --forceExit
fi

echo "==> Passed ($TIER)"
