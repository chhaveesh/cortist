# Cortist — Phase 1: Telegram Gateway + Message Queue

The ingestion layer for Cortist, a Telegram-based AI personal assistant.

This phase covers **only** receiving Telegram messages and reliably queuing them
for asynchronous processing. There is no agent logic, no LLM calls, and no
calendar/RAG/task/email code here — those arrive in later phases and plug into
the queue contract described below.

---

## Quick start

Requirements: Docker (with Compose v2) and, for running tests outside a
container, Node.js 20+.

```bash
cp .env.example .env
docker compose up
```

That is the whole setup. The stack comes up with migrations already applied.

> **`TELEGRAM_WEBHOOK_SECRET` is not just a local setting.** The gateway rejects
> any request whose `X-Telegram-Bot-Api-Secret-Token` header does not match it.
> For a real deployment the same value must be registered with Telegram at
> `setWebhook` time (see [Registering a real webhook](#registering-a-real-webhook-optional-not-needed-for-development)) —
> setting it in `.env` alone means Telegram's deliveries get 401s. The default
> in `.env.example` is fine for local development and the test suite.

> **Port already in use?** If you run Postgres or Redis natively on 5432/6379,
> set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` to something free.
> These only affect access from your machine; the services always reach each
> other over the compose network.

Verify it is alive:

```bash
curl localhost:3000/health
# {"status":"ok","postgres":"up","redis":"up"}
```

Send a simulated Telegram delivery (no bot token or public URL needed):

```bash
curl -X POST localhost:3000/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: local-dev-webhook-secret' \
  -d '{
    "update_id": 900100201,
    "message": {
      "message_id": 777001,
      "from": {"id": 424242, "is_bot": false, "first_name": "Ada"},
      "chat": {"id": 424242, "type": "private"},
      "date": 1768000000,
      "text": "What is on my calendar tomorrow?"
    }
  }'
# {"ok":true,"status":"enqueued"}
```

Then watch the worker pick it up:

```bash
docker compose logs -f worker
# [TelegramMessageProcessor] Processing message 777001 from chat 424242 for tenant <uuid>: "..."
```

POST the same payload again and the response becomes
`{"ok":true,"status":"duplicate"}` — still a 200, but no second job.

---

## Architecture

```
  Telegram
     │  POST /telegram/webhook  (X-Telegram-Bot-Api-Secret-Token)
     ▼
┌──────────────────────────────────────────────┐
│  GATEWAY  (src/main.ts — HTTP, stateless)    │
│                                              │
│  1. TelegramSecretGuard   verify shared secret  → 401
│  2. ZodValidationPipe     validate Update shape → 400
│  3. IdempotencyService    SETNX claim on (chat, message) → "duplicate"
│  4. UsersService          find-or-create tenant
│  5. QueueService.enqueue  versioned job payload
│  6. return 200                               │
└───────────────┬──────────────────────────────┘
                │  BullMQ job on "telegram-messages"
                ▼
        ┌───────────────┐          ┌────────────┐
        │     Redis     │          │  Postgres  │
        │ queue + dedupe│          │ users +    │
        └───────┬───────┘          │ processed_ │
                │                  │ messages   │
                ▼                  └─────▲──────┘
┌──────────────────────────────────────┐ │
│  WORKER  (src/worker.ts — no HTTP)   │ │
│  re-validates the contract, then     │─┘
│  writes a processed marker (STUB)    │
└──────────────────────────────────────┘
```

**Why the gateway is thin.** Telegram re-sends any update it does not get a
prompt 200 for. Every millisecond of work in the handler is a millisecond
closer to a duplicate delivery, so the handler does the minimum needed to take
durable ownership of a message and returns.

**Why the worker is a separate process.** Phase 2+ scales agent processing
independently of ingestion (`docker compose up --scale worker=4`). The two have
separate composition roots — `AppModule` never imports `WorkerModule`, so the
gateway cannot accidentally start consuming from its own queue.

### Idempotency

Two layers, in order:

1. **Redis `SET NX`** on `cortist:dedupe:tg:{chatId}:{messageId}` — the
   authoritative check. Atomic, so concurrent retries collapse to exactly one
   winner. Expires after `DEDUPE_TTL_SECONDS` (24h default), well beyond
   Telegram's retry window.
2. **BullMQ `jobId`** of `tg:{chatId}:{messageId}` — a backstop for the case
   where the dedupe key has expired but the job is still retained.
3. **Unique constraint** on `processed_messages(chat_id, message_id)` — the
   durable last line, making the worker itself idempotent.

If enqueueing fails after a claim is taken, the claim is **released** so
Telegram's retry can make progress instead of being deduped into a black hole.

### The queue contract

`src/common/contracts/telegram-message.job.ts` is the seam between this phase
and every future agent. Treat it as a published API.

```jsonc
{
  "jobType": "telegram_message",
  "version": 1,
  "tenantId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", // internal users.id
  "telegramUserId": "123456789",   // string: 64-bit, JSON has no wide int
  "chatId": "-1001234567890",      // string, same reason; may be negative
  "messageId": 42,                 // unique within a chat
  "text": "What is on my calendar tomorrow?",
  "receivedAt": "2026-07-19T12:00:00.000Z" // ISO-8601 UTC, gateway clock
}
```

Consumers should switch on `version`. To evolve, **add** a `V2` schema and widen
the discriminated union — never repurpose a v1 field, so jobs already sitting in
Redis keep deserializing during a rolling deploy.

`tenantId` is Cortist's internal user id, not the Telegram id. Downstream agents
should key all per-user state off it.

---

## Testing

```bash
npm install
npm run test:e2e     # unit + integration + end-to-end, fully dockerized
```

Tiers can also be run individually:

```bash
npm test                 # unit only — no Docker needed, runs in seconds
npm run test:integration # integration tier (starts/stops its own containers)
npm run test:e2e:only    # end-to-end tier only
```

That one command starts isolated Postgres and Redis containers, applies
migrations, runs every suite, and tears the containers down again. It needs no
Telegram bot token, no public URL, and no ngrok tunnel — Telegram is simulated
by POSTing fixtures that match its real webhook schema.

The test stack is deliberately isolated from your dev stack: its own compose
project (`cortist-test`), its own ports (55432 / 56379), and tmpfs storage, so
every run starts clean and your dev data is never touched.

```bash
KEEP_TEST_STACK=1 npm run test:e2e   # leave containers up to iterate on a failure
```

| Tier | File | Covers |
| --- | --- | --- |
| Unit | `test/unit/telegram.schema.spec.ts` | payload validation, actionable-message extraction |
| Unit | `test/unit/telegram.service.spec.ts` | job construction, claim ordering, claim release on failure |
| Unit | `test/unit/idempotency.service.spec.ts` | SETNX semantics, key namespacing |
| Unit | `test/unit/telegram-message.job.spec.ts` | the versioned contract itself |
| Integration | `test/integration/webhook.integration-spec.ts` | 200 + job on queue + user row; secret-token rejection |
| Integration | `test/integration/duplicate.integration-spec.ts` | sequential and concurrent duplicate deliveries |
| Integration | `test/integration/malformed.integration-spec.ts` | 4xx on bad payloads, nothing enqueued |
| Integration | `test/integration/health.integration-spec.ts` | `/health` 200, and 503 per failed dependency |
| End-to-end | `test/e2e/pipe.e2e-spec.ts` | gateway → queue → **real worker** → Postgres |
| End-to-end | `test/e2e/shutdown.e2e-spec.ts` | SIGTERM drain, no stranded jobs, clean handover |
| End-to-end | `test/e2e/retry.e2e-spec.ts` | 3 attempts, exponential backoff, failed set |

The end-to-end test boots the worker from `WorkerAppModule` — the same
composition root `dist/worker.js` uses in production — so it exercises the real
process boundary rather than a stand-in.

---

## Operational behaviour

### Health checks

`GET /health` probes both dependencies on every call and reports what it found:

```jsonc
// 200
{ "status": "ok", "redis": "connected", "postgres": "connected" }

// 503 — the load balancer should pull this instance out of rotation
{
  "status": "error",
  "redis": "connected",
  "postgres": "disconnected",
  "failures": [{ "dependency": "postgres", "error": "Can't reach database server..." }]
}
```

It is wired into the `gateway` service's compose `healthcheck`, so
`docker compose ps` reflects real readiness rather than "the container started".
Verify the failure path by hand:

```bash
docker compose stop postgres
curl -i localhost:3000/health     # 503, postgres: disconnected
docker compose start postgres
curl -i localhost:3000/health     # 200 once it recovers
```

### Retry and failure policy

Every job gets **3 attempts** with **exponential backoff from a 2s base** — so
retries land at roughly 2s and 4s, and a job gives up after about 6s. Long
enough to ride out a brief dependency blip, short enough that a genuinely
broken message surfaces quickly.

Once attempts are exhausted the job moves to BullMQ's **failed set**, where it
is retained (24h) and replayable — never silently dropped. The worker logs each
retry at `warn` and the terminal failure at `error`.

A payload that fails contract validation is `discard()`ed instead: it can never
become valid, so retrying it is pure waste. It fails once and lands in the same
failed set.

The policy lives in `src/queue/queue.constants.ts` and is applied as a queue
default, so every producer inherits it.

### Graceful shutdown

On `SIGTERM` (every ECS Fargate deploy and scale-down) or `SIGINT` (Ctrl+C), the
worker stops fetching new jobs, finishes what it is already holding, and exits —
bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` (10s default).

```
[TelegramMessageWorker] Shutdown (SIGTERM): no longer accepting jobs, waiting up to 10000ms for in-flight work
[TelegramMessageWorker] Shutdown complete: in-flight jobs finished in 3ms
```

If a job outruns the timeout the process exits anyway rather than waiting for
the platform's SIGKILL. That job is **not** lost: it stays in BullMQ's active
set and is recovered as a stalled job by the next worker, then retried under the
policy above. Keep the timeout below your orchestrator's kill grace period
(Fargate's `stopTimeout` defaults to 30s).

Verify by hand:

```bash
docker compose stop worker          # sends SIGTERM
docker compose logs worker | grep Shutdown
docker compose exec redis redis-cli LLEN bull:telegram-messages:active   # 0
```

## Code quality

```bash
npm run lint          # ESLint + TypeScript rules
npm run lint:fix      # autofix what can be autofixed
npm run format        # Prettier, writes in place
npm run format:check  # Prettier, verify only (for CI)
```

Prettier is the sole authority on formatting; ESLint defers to it via
`plugin:prettier/recommended`, so the two can never disagree. Both run clean
across the whole codebase.

## Project layout

```
src/
  main.ts                    entrypoint: HTTP gateway
  worker.ts                  entrypoint: queue worker (no HTTP listener)
  app.module.ts              gateway composition root
  worker.module.root.ts      worker composition root
  common/contracts/          ← the queue contract (the Phase 2 seam)
  config/                    zod-validated environment
  telegram/                  webhook controller, secret guard, schema, ingestion
  queue/                     QueueService port + BullMQ adapter
  idempotency/               Redis SETNX dedupe
  users/                     tenant find-or-create
  prisma/ redis/ health/     infrastructure
  worker/                    BullMQ worker lifecycle + stub processor
prisma/                      schema + migrations
test/
  harness.ts                 shared boot/reset helpers for the two docker tiers
  fixtures/                  realistic Telegram Update payloads
  unit/ integration/ e2e/    the three test tiers
scripts/test-stack.sh        the dockerized test runner (integration | e2e | all)
```

## Environment variables

Every variable is documented inline in `.env.example`, and validated at boot by
`src/config/env.schema.ts` — a malformed environment fails the process
immediately rather than surfacing later as a confusing runtime error.

`TELEGRAM_BOT_TOKEN` is only needed to *send* messages (Phase 2+); a placeholder
is fine for all of Phase 1, including the full test suite.

## Registering a real webhook (optional, not needed for development)

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-host/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Telegram then echoes `secret_token` in the `X-Telegram-Bot-Api-Secret-Token`
header on every delivery, which `TelegramSecretGuard` verifies in constant time.

## What Phase 2 plugs into

- Add a processor alongside `TelegramMessageProcessor` and register it in
  `WorkerModule`. The gateway needs no changes.
- Consume `TelegramMessageJobV1` from `src/common/contracts/`. Key state off
  `tenantId`.
- Replace the `processed_messages` write in the stub processor with real agent
  routing.
- Swapping BullMQ for SQS means adding one `QueueService` implementation and
  changing the `useClass` in `src/queue/queue.module.ts`.

See `DECISIONS.md` for the judgment calls behind all of this.
