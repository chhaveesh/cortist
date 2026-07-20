-- Cached IANA timezone for the user's primary calendar.
--
-- Nullable: a user who has never connected a calendar has no timezone, and the
-- router falls back to UTC. Previously this was fetched from Google on every
-- calendar message purely to resolve relative times — caching it removes that
-- round trip AND lets the router extract times without any calendar access.
ALTER TABLE "users" ADD COLUMN "time_zone" TEXT;

-- CreateTable
CREATE TABLE "pending_clarifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "original_text" TEXT NOT NULL,
    "route_a" TEXT NOT NULL,
    "route_b" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_clarifications_pkey" PRIMARY KEY ("id")
);

-- One outstanding routing question per tenant: a new one supersedes the old,
-- so the user's "the calendar one" is never ambiguous about which question it
-- answers.
CREATE UNIQUE INDEX "pending_clarifications_user_id_key" ON "pending_clarifications"("user_id");
CREATE INDEX "pending_clarifications_expires_at_idx" ON "pending_clarifications"("expires_at");

-- AddForeignKey
ALTER TABLE "pending_clarifications" ADD CONSTRAINT "pending_clarifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
