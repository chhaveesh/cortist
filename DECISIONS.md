# Decisions — Phase 1

Judgment calls made while building the ingestion layer, with the reasoning
behind each. Where a decision constrains Phase 2, that is called out.

---

## 1. Prisma over TypeORM

**Chosen: Prisma.**

The generated client's types are exact rather than inferred, `prisma migrate`
produces reviewable SQL from a declarative schema, and `schema.prisma` doubles
as readable documentation of the data model — worth a lot on a repo intended to
be handed to someone else.

Cost: a `prisma generate` step in the Dockerfile, and `BigInt` columns come back
as JS `BigInt` (see §6).

**Related:** `prisma` (the CLI) is a **runtime** dependency, not a dev one. The
production image must run `prisma migrate deploy` and generate its own client
without reaching the network. Installing the CLI only as a devDependency
produced an image whose Prisma query engine was missing at runtime — the
container started, then crash-looped on first database access.

## 2. Two compose services, one image

`gateway` and `worker` are separate services built from the same image,
differing only in `command` (`dist/main.js` vs `dist/worker.js`).

One image keeps the build simple and guarantees the two processes run identical
code. Separate services preserve the boundary Phase 2 needs:
`docker compose up --scale worker=4` scales processing without touching
ingestion.

The boundary is enforced in code, not just convention: `AppModule` (gateway) and
`WorkerAppModule` (worker) are separate composition roots, and `AppModule` never
imports `WorkerModule`. The gateway therefore *cannot* start consuming from its
own queue by accident.

A third one-shot `migrate` service applies migrations and exits; both app
services declare `service_completed_successfully` on it, so neither can start
against an un-migrated database.

## 3. Job payload versioning

`version` is a zod **literal**, and `telegramMessageJobSchema` is a
**discriminated union** over it — currently with one member.

This makes evolution additive. A future `TelegramMessageJobV2` is appended to
the union rather than replacing v1, so during a rolling deploy the new worker
still deserializes v1 jobs already sitting in Redis. Mutating v1 in place would
turn every in-flight job into a hard failure at the exact moment of deploy.

Consumers switch on `version`. The worker re-validates at its own boundary even
though it trusts today's producer: once several services write to this queue, a
bad payload should fail one job loudly rather than corrupt state quietly.

## 4. Three layers of idempotency

Telegram re-sends any update it does not get a prompt 200 for, so duplicate
delivery is normal traffic, not an error condition.

1. **Redis `SET NX`** on `(chatId, messageId)` — authoritative. Atomic, so N
   concurrent retries produce exactly one winner. This is tested explicitly
   with four simultaneous deliveries.
2. **BullMQ `jobId`** = `tg:{chatId}:{messageId}` — backstop for when the dedupe
   key has expired but the job is still retained.
3. **Unique constraint** on `processed_messages(chat_id, message_id)` — durable
   last line; the worker catches `P2002` and treats it as success.

Two details that matter:

- The claim is taken **before** any database or queue work, so a retry costs one
  Redis round trip rather than a wasted transaction. There is a unit test
  asserting this ordering, because it is easy to break during a refactor and
  produces no visible symptom when broken.
- If enqueueing fails *after* a claim succeeds, the claim is **released**.
  Without this, a transient Redis or Postgres blip would permanently swallow the
  message: Telegram's retry would be deduped against a claim for work that never
  happened.

`(chatId, messageId)` — not `messageId` alone — is the dedupe key, because
Telegram message ids are only unique *within* a chat.

## 5. Duplicates return 200, not 409

A duplicate is answered `200 {"status":"duplicate"}`. Any non-2xx tells Telegram
to retry, and retrying a message we have already accepted just generates more
duplicates. The same reasoning applies to schema-valid updates we deliberately
ignore (stickers, bot-authored messages): they return
`200 {"status":"ignored"}`.

Genuinely malformed payloads still return 400, and a bad secret returns 401 —
those represent traffic that should not be retried *and* should be visible.

## 6. 64-bit ids travel as strings

Telegram user and chat ids are 64-bit and exceed `Number.MAX_SAFE_INTEGER` for
large channels; supergroup chat ids are additionally negative. JSON has no
integer type wide enough, so the queue contract encodes them as decimal strings
and validates with a regex.

Postgres stores them as `BIGINT`, and Prisma surfaces them as JS `BigInt`.
`JSON.stringify` throws on `BigInt` by default, so `registerBigIntJson()`
installs a `toJSON` that serializes to a decimal string — matching the wire
format, so the two representations agree.

## 7. Validation is permissive about unknown fields

The zod `Update` schema models only what Phase 1 consumes and uses
`.passthrough()` for everything else.

Telegram ships new fields regularly. A strict schema would start rejecting
perfectly valid production traffic the day Telegram adds a field — an outage
caused by someone else's release. Required-field violations are still rejected
with a 400.

Schema validity and *actionability* are kept separate: `telegramUpdateSchema`
decides whether the request is well-formed (400 if not), while
`extractActionableMessage` decides whether there is anything to route (200,
ignored, if not).

## 8. Webhook auth via `X-Telegram-Bot-Api-Secret-Token`

Telegram's official mechanism, registered once via `setWebhook`'s `secret_token`
parameter and echoed on every delivery. Compared in constant time.

Preferred over a secret embedded in the URL path, which leaks into access logs,
proxy metrics, and error reports. Without any check, anyone who learns the
webhook URL can inject messages attributed to arbitrary Telegram users.

## 9. Queue behind a port

The gateway depends on the abstract `QueueService`, never on BullMQ. The BullMQ
adapter is bound in one line in `QueueModule`.

Moving to SQS means adding `SqsQueueService implements QueueService` and
changing that binding — no controller or ingestion-path service changes.
`EnqueueOptions.jobId` maps cleanly onto SQS FIFO's deduplication id.

`EnqueueResult.enqueued` is explicitly documented as advisory: not every backend
can report a duplicate, so correctness must not depend on it. The Redis claim is
what correctness rests on.

## 10. Tests use a compose profile, not testcontainers

`npm run test:e2e` drives `docker-compose.test.yml` via `scripts/test-stack.sh`
(renamed from `test-e2e.sh` in §19, when the tiers were split).

No extra dependency, works offline once the images are pulled, and the same
compose primitives are already used for dev — one less thing for a new
contributor to learn. Testcontainers would give per-test isolation, but the
suite runs serially and truncates state between tests, so that is not needed
yet.

Isolation from dev data is deliberate and layered: a separate compose project
(`cortist-test`), non-default host ports (55432 / 56379) so it can run alongside
the dev stack, and tmpfs storage so nothing survives a run. `test/setup-env.ts`
loads `.env.test` with `override: true` specifically so a developer with a
shell-exported `DATABASE_URL` pointing at their dev database cannot have the
suite truncate it.

`.env.test` is committed on purpose — throwaway credentials for ephemeral
containers, and the suite must run with zero manual setup.

## 11. The app is not containerised in the test stack

Jest boots the Nest gateway and worker **in-process** against the containerised
Postgres and Redis.

This keeps assertions direct (the test holds real `PrismaService` and `Queue`
handles) and the edit-test loop fast. The end-to-end test still boots the worker
from `WorkerAppModule` — production's own composition root — so the process
boundary is genuinely exercised; only the packaging differs.

The Docker image itself is verified separately, by `docker compose up` plus the
smoke sequence in the README.

## 12. `processed_messages` as the worker's proof of life

The stub worker writes a row rather than only logging. A log line is awkward to
assert on and easy to lose; a row is a durable, queryable marker that makes the
end-to-end test a real assertion instead of a string match on stdout.

The table earns its place beyond testing: its unique constraint is idempotency
layer 3 (§4). Phase 2 replaces the write with real agent routing.

## 13. Host ports are configurable

`POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` default to 5432 / 6379 but are
overridable.

Found while verifying `docker compose up` on a machine already running Postgres
natively: the stack failed to start with a port-binding error. Since these
publish ports purely for host convenience — services reach each other over the
compose network regardless — making them configurable preserves the
one-command promise for developers with existing local databases.

---

## Deferred at the end of the initial build

- **Rate limiting / abuse protection** on the webhook. The secret token gates
  access; per-tenant throttling belongs with real traffic patterns to size it
  against.
- **Dead-letter queue.** Jobs currently retry 3× with exponential backoff, then
  land in BullMQ's failed set, which is inspectable. A DLQ with alerting is a
  Phase 2+ operational concern.
- **Structured JSON logging and tracing.** Nest's default logger is adequate
  for a single-node local stack; correlation ids become valuable once messages
  fan out across sub-agents.
- **Non-text messages** (voice, images, documents) are acknowledged and dropped.
  Routing them requires knowing what the agents can consume.
- **Outbound Telegram replies.** `TELEGRAM_BOT_TOKEN` is wired through config
  and validated, but nothing sends yet — that arrives with the first agent.

---

# Phase 1 hardening

A follow-up pass closing five gaps before Phase 2 builds on this. Two items
(webhook secret verification, `/health`) were already present from the initial
build and only needed completing rather than implementing; that is noted below.

## 14. Webhook secret verification — already in place, docs completed

`TelegramSecretGuard` (§8) already verified `X-Telegram-Bot-Api-Secret-Token`
in constant time, and Nest runs guards **before** pipes, so verification already
happened before any payload parsing. The 401 cases were already covered by
tests.

What was missing was documentation of the operational half: the secret must be
registered with Telegram at `setWebhook` time, not merely set in `.env`. Setting
it locally alone means every real Telegram delivery 401s — a failure mode that
would be baffling to debug. Both `.env.example` and the README setup section now
say so explicitly.

**Touched:** `.env.example`, `README.md`.

## 15. Bounded graceful shutdown

`worker.close()` already ran via Nest's shutdown hooks, which stops fetching new
jobs and waits for in-flight ones. Three things were missing: a bound on the
wait, visible logging, and a test.

**Behaviour chosen: wait up to `WORKER_SHUTDOWN_TIMEOUT_MS` (10s), then exit
anyway and leave the job retryable.**

The alternative — waiting indefinitely — is worse. ECS Fargate SIGKILLs the
container after `stopTimeout` (30s by default) regardless of what we want, so an
unbounded wait does not save the job; it just guarantees the least graceful
possible ending, with no log line explaining it. Exiting deliberately at 10s
keeps us inside the platform's grace period and produces a clear warning.

An abandoned job is not lost. It remains in BullMQ's active set with no live
owner, and the next worker's stalled-job checker reclaims it and retries it
under the normal attempts/backoff policy (§16). This is why the timeout must
stay comfortably below the orchestrator's grace period — configurable, so it can
be tuned per environment rather than hard-coded.

**On testing this:** the test drives `app.close()` rather than signalling a real
process. Nest's `enableShutdownHooks()` makes SIGTERM a thin wrapper around
exactly that call, so this exercises the real path without the flakiness of
cross-process signalling. The assertions are behavioural rather than
log-scraping: after shutdown, zero jobs are stranded in `active`, and every job
is accounted for as either completed or still queued. A third test runs the full
deploy cycle — worker dies mid-backlog, replacement finishes it — and asserts no
message is processed twice across the handover.

**Touched:** `src/worker/worker.module.ts`, `src/worker.ts`,
`src/config/env.schema.ts`, `test/e2e/shutdown.e2e-spec.ts`.

## 16. Explicit retry and backoff policy

Attempts were already 3 with exponential backoff, but from a **1s** base that
had never been argued for. Raised to a **2s** base per spec, and both values
moved into named constants in `queue.constants.ts` so the policy is stated once
and inherited by every producer rather than being a magic number inside the
BullMQ adapter.

Retries now land at ~2s and ~4s. The failure logging distinguishes the two cases
that matter operationally: a retryable failure logs at `warn` with the attempt
count, while exhausting all attempts logs at `error` and names the failed set —
the difference between "this is being handled" and "a human needs to look".

**On testing this:** the failing job is induced with a `messageId` that
overflows Postgres' `INT4` column, which raises a genuine driver-level error
from inside the processor. A mock that throws would test that BullMQ retries;
this tests that *our* processor's real failure path retries. Three assertions:
the policy is present on enqueued jobs, a failing job makes exactly
`JOB_ATTEMPTS` attempts and lands in the failed set, and elapsed time confirms
it actually backed off rather than burning through retries instantly.

A fourth test pins the contrasting case: a structurally invalid payload is
`discard()`ed and fails after **one** attempt, since no amount of retrying will
make it parse.

**Touched:** `src/queue/queue.constants.ts`, `src/queue/bullmq-queue.service.ts`,
`src/worker/worker.module.ts`, `test/e2e/retry.e2e-spec.ts`.

## 17. `/health` now returns 503

The endpoint already probed Redis and Postgres for real and was already wired
into the compose healthcheck. The gap was that it returned **200 even when
degraded**, reporting `"status": "degraded"` in the body — which no load
balancer reads. An ALB looks at the status code and nothing else, so a degraded
instance would have kept receiving traffic it could not serve.

It now returns 503 with a `failures` array naming each broken dependency and its
error. `@Res()` is used to set the status directly, which is simpler than
throwing an exception just to have a filter turn it back into the body shape
this endpoint already builds.

**On testing this:** stopping a container mid-suite would break every other test
sharing it, so the 503 tests force the probes to reject, exercising the same
branch. The genuine outage path was verified by hand against the running stack
(`docker compose stop postgres` → 503 naming postgres → restart → 200), and that
procedure is documented in the README so it stays reproducible.

**Touched:** `src/health/health.controller.ts`,
`test/integration/health.integration-spec.ts`, `README.md`.

## 18. ESLint and Prettier

Added `@typescript-eslint` with `plugin:prettier/recommended` last in the extends
chain, so Prettier owns formatting outright and the two tools cannot disagree.

Beyond the recommended set, three rules were enabled deliberately:
`no-floating-promises` (an unawaited promise in a queue consumer is silently
dropped work), `await-thenable`, and `no-explicit-any` (the codebase is strict;
`any` should be an argued exception). Tests relax `no-explicit-any` because they
construct deliberately malformed payloads.

This immediately earned its place: `await-thenable` caught an `await` on
`job.discard()`, which is **synchronous** in BullMQ v5. Harmless at runtime, but
it misrepresented the API in a spot where a reader would reasonably assume the
discard was being persisted before the throw.

**Touched:** `.eslintrc.js`, `.prettierrc`, `package.json`,
`src/worker/telegram-message.processor.ts`, plus formatting-only changes across
the codebase.

## 19. Test tiers split into three

The suite was two configs (unit, and everything-dockerized-together). It is now
three — `test/unit/`, `test/integration/`, `test/e2e/` — with a script per tier.

The tiers now mean distinct things: integration asserts each edge in isolation
(webhook → queue, webhook → database, health → dependencies), while e2e asserts
behaviour that only exists across the whole chain (delivery to a real worker,
shutdown drain, retry exhaustion). Running the cheap tier alone is now possible,
which matters as the e2e tier grows — the retry tests alone take ~14s because
they genuinely wait out the backoff.

`scripts/test-e2e.sh` became `scripts/test-stack.sh <tier>`. `npm run test:e2e`
still runs everything, preserving the original one-command promise.

**Touched:** `jest.integration.config.js`, `jest.e2e.config.js`,
`scripts/test-stack.sh`, `package.json`, `test/harness.ts` (shared helpers
lifted out of the pipe spec so all tiers use one boot path).

---

## Still deferred after hardening

The Phase 1 deferrals above stand, minus what this pass covered. Specifically
still open: rate limiting, a dedicated dead-letter queue with alerting (failed
jobs are retained and visible, but nothing pages), structured JSON logging and
trace correlation, non-text message handling, and outbound Telegram replies.
