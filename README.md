# Cortist — Telegram Gateway, Message Queue, and Calendar Agent

A Telegram-based AI personal assistant.

- **Phase 1** — the ingestion layer: receive Telegram messages and reliably queue
  them for asynchronous processing.
- **Phase 2** — the first sub-agent: a Google Calendar agent the worker
  dispatches queued messages to, covering create / reschedule / delete with
  conflict detection and confirmation before anything destructive.

RAG, task, and email agents arrive in later phases and plug into the same queue
contract described below.

---

## Quick start

Requirements: Docker (with Compose v2) and, for running tests outside a
container, Node.js 20+.

```bash
cp .env.example .env
docker compose up
```

That is the whole setup. The stack comes up with migrations already applied.

> **With placeholder credentials, calendar replies will fail — expected.** The
> stack starts and the pipe works, but the moment the agent tries to *reply*
> (an OAuth link, a confirmation prompt) it calls the Telegram API, and a
> placeholder `TELEGRAM_BOT_TOKEN` gets a 404. The job then retries three times
> and lands in the failed set. Non-calendar messages are unaffected — they're
> filtered out before any outbound call. Set a real bot token and the Google
> credentials below to exercise the agent end to end.

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
│  hands the job to the CALENDAR AGENT │
└───────────────┬──────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  CALENDAR AGENT  (src/agents/calendar/)                  │
│                                                          │
│  1. pending confirmation?  → yes/no resolves it FIRST    │
│  2. keyword pre-filter     → skip without an LLM call    │
│  3. no calendar connected? → reply with an OAuth link    │
│  4. classify intent (Claude Haiku 4.5, structured output)│
│  5. create      → conflict-check, then execute           │
│     reschedule  → resolve event, conflict-check, ASK     │
│     delete      → resolve event, ASK                     │
└───────────────┬──────────────────────────────────────────┘
                ▼
        Google Calendar API (calendar.events scope only)
```

**Why the pending-confirmation check runs first.** A user replying "yes"
sends an ordinary Telegram message. Classified normally it comes back
`not_calendar_related`, and the pending action would be stranded forever. So
the agent checks for an outstanding confirmation before it classifies anything.

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
| Unit | `test/unit/token-encryption.service.spec.ts` | round-trip, fresh IV per call, tamper and wrong-key rejection |
| Unit | `test/unit/oauth-state.service.spec.ts` | signature forgery, expiry, clock skew |
| Unit | `test/unit/calendar-intent.schema.spec.ts` | intent narrowing; wire schema vs zod schema agreement |
| Unit | `test/unit/calendar-keyword-filter.spec.ts` | pre-filter hits, misses, and its **known blind spots** |
| Unit | `test/unit/confirmation-reply.spec.ts` | yes/no/unclear, including "no, cancel it" → negative |
| Unit | `test/unit/conflict-detector.service.spec.ts` | overlap maths, touching boundaries, all-day, self-exclusion |
| Integration | `test/integration/google-oauth.integration-spec.ts` | consent redirect, callback, **encrypted** storage, tenant correlation |
| Integration | `test/integration/oauth-token-refresh.integration-spec.ts` | transparent refresh, refresh-token preservation, revocation |
| Integration | `test/integration/calendar-create.integration-spec.ts` | create on a free slot; **nothing created** on a clash |
| Integration | `test/integration/calendar-confirmation.integration-spec.ts` | prompt sent + **nothing executed**; yes / no / unclear / expired |
| Integration | `test/integration/calendar-connection.integration-spec.ts` | OAuth link when unconnected; reconnect prompt on revocation |
| Integration | `test/integration/calendar-ambiguity.integration-spec.ts` | 0 matches, 2+ matches, event vanishing mid-confirmation |
| End-to-end | `test/e2e/pipe.e2e-spec.ts` | gateway → queue → **real worker** → Postgres |
| End-to-end | `test/e2e/shutdown.e2e-spec.ts` | SIGTERM drain, no stranded jobs, clean handover |
| End-to-end | `test/e2e/retry.e2e-spec.ts` | 3 attempts, exponential backoff, failed set |

### No real Google, Anthropic, or Telegram calls

That property is **structural, not a convention**. `test/calendar-harness.ts`
overrides exactly four providers:

| Token | Replaced by |
| --- | --- |
| `CalendarClient` | `FakeCalendarClient` — in-memory events, seedable, simulates 401/404/429 |
| `CalendarIntentClassifier` | `ScriptedIntentClassifier` — returns queued intents, records its inputs |
| `GoogleOAuthClient` | `FakeGoogleOAuthClient` — canned token exchange and refresh |
| `TelegramSenderService` | `RecordingTelegramSender` — captures what the user was told |

Those are the code's only routes to the outside world, so reaching the network
would require deliberately binding the real implementations back. No API key,
bot token, or tunnel is needed to run the suite.

The scripted classifier **throws on an unscripted call** rather than returning a
default — an unexpected classification means the agent took a path the test
didn't anticipate, which is worth failing over.

And the property is **enforced, not assumed**: `test/network-guard.ts` wraps
`fetch` and the `http`/`https` modules and fails any test that reaches a
non-localhost host. It exists because the assumption was once wrong — after the
agent was wired into the worker, the e2e tier booted the real module graph and
genuinely called `api.telegram.org`, surfacing only as a confusing timeout. The
guard has its own tests (`test/unit/network-guard.spec.ts`), because a guard
nobody tests produces false confidence.

The end-to-end test boots the worker from `WorkerAppModule` — the same
composition root `dist/worker.js` uses in production — so it exercises the real
process boundary rather than a stand-in.

---

## The calendar agent

### What it does

| You say | It does |
| --- | --- |
| "book a dentist appointment tomorrow at 9" | Checks for clashes, then **creates it** and confirms |
| "move my dentist appointment to 2pm" | Resolves the event, checks the new slot, then **asks before moving** |
| "cancel my dentist appointment" | Resolves the event, then **asks before deleting** |
| "reschedule my call" (with three calls) | Lists them and asks which one |
| "what's the capital of France?" | Nothing — filtered out before any LLM call |

**Create executes directly; delete and reschedule require an explicit "yes".**
Creating is additive, conflict-checked, and trivially undone — and the summary
sent afterwards makes a mistake visible immediately. Deleting destroys data, and
rescheduling moves a commitment other people may have planned around. Those two
get a confirmation prompt naming the exact event, and nothing happens until you
reply.

A pending confirmation expires after `PENDING_ACTION_TTL_SECONDS` (5 min
default). Replying with a *new* calendar request instead of yes/no supersedes
the old one — your "yes" always refers to the most recent question.

### Connecting a calendar

The first time you send a calendar message, the bot replies with a link. That
link carries a **signed, short-lived `state` parameter** containing your tenant
id — which is how the Google callback gets correlated back to the right user,
given there is no browser session tying the two together. Forging it is the
attack the signature exists to stop.

Access tokens are refreshed transparently: if one has expired when the agent
needs it, the refresh happens before the API call and the new token is stored.
A rejected refresh token (you revoked access in your Google account) can't be
fixed by retrying, so the agent prompts you to reconnect instead.

Both tokens are encrypted at rest with **AES-256-GCM** before they touch the
database. Nothing in `oauth_tokens` is readable without `TOKEN_ENCRYPTION_KEY`.

### Google Cloud Console setup

Needed only for a real calendar. The automated test suite requires none of it.

1. **Create or pick a project** at [console.cloud.google.com](https://console.cloud.google.com).
2. **Enable the Calendar API** — APIs & Services → Library → "Google Calendar API" → Enable.
3. **Configure the OAuth consent screen** — APIs & Services → OAuth consent screen.
   - User type **External** is fine for personal use.
   - Add the scope `https://www.googleapis.com/auth/calendar.events`. Do **not**
     add the broader `calendar` scope — the agent does not need it.
   - While the app is unverified it stays in *Testing* mode, so add your own
     Google account under **Test users**. Anyone not listed gets
     `403 access_denied`.
4. **Create the OAuth client** — Credentials → Create credentials → OAuth client
   ID → **Web application**.
   - Under *Authorized redirect URIs* add exactly
     `http://localhost:3000/auth/google/callback`.
   - Google matches this string **exactly** — scheme, host, port, and path. A
     trailing slash or `127.0.0.1` instead of `localhost` will fail.
5. **Copy the client ID and secret** into `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, and set `GOOGLE_REDIRECT_URI` to the same URI you
   registered.

Then generate the two secrets:

```bash
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY  (must be 64 hex chars)
openssl rand -hex 32   # → OAUTH_STATE_SECRET
```

And set `ANTHROPIC_API_KEY` from
[console.anthropic.com](https://console.anthropic.com/settings/keys).

### Manual verification against a real calendar

**Deliberately not automated.** The suite mocks Google entirely (see
[Testing](#testing)); this is a one-time check that the real client, real OAuth,
and real Telegram wiring work end to end. Do it once after setting up
credentials.

You need: the Google setup above, a bot token from
[@BotFather](https://t.me/BotFather), and a way to expose port 3000 publicly for
Telegram to reach (e.g. `ngrok http 3000`, then set `PUBLIC_BASE_URL` and
`GOOGLE_REDIRECT_URI` to the tunnel URL and re-register both with Google and
`setWebhook`).

1. **Start the stack** — `docker compose up -d --wait`, then `curl localhost:3000/health`.
2. **Register the webhook**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-tunnel>/telegram/webhook" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```
3. **Connect** — message your bot "what's on my calendar tomorrow?". It should
   reply with a link. Follow it, consent, and confirm you land on the "Calendar
   connected" page and get a Telegram confirmation.
   - Verify the tokens are encrypted:
     ```bash
     docker compose exec postgres psql -U cortist -d cortist \
       -c 'SELECT access_token_encrypted FROM oauth_tokens;'
     ```
     You should see a `v1:…` envelope, not a readable token.
4. **Create** — "book a dentist appointment tomorrow at 3pm for an hour".
   Confirm the event appears in Google Calendar at the right time *in your own
   timezone* — this is the check that the timezone resolution works.
5. **Conflict** — ask for another event at the same time. It should refuse and
   name the clash, and **no** second event should appear.
6. **Reschedule** — "move my dentist appointment to 5pm". Confirm it asks first;
   check Google Calendar shows the event *unmoved*. Reply "yes", then confirm it
   moved and kept its one-hour duration.
7. **Delete** — "cancel my dentist appointment". Confirm it asks; reply "no" and
   check the event survives. Ask again, reply "yes", and confirm it's gone.
8. **Token refresh** — leave it for over an hour (Google access tokens last
   ~1h), then send another calendar message. It should work without
   reconnecting. `docker compose logs worker | grep Refreshing` confirms the
   refresh actually happened.

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
    outbound/                Bot API sender (the agent's voice)
  queue/                     QueueService port + BullMQ adapter
  idempotency/               Redis SETNX dedupe
  users/                     tenant find-or-create
  prisma/ redis/ health/     infrastructure
  worker/                    BullMQ worker lifecycle + processor
  crypto/                    AES-256-GCM token encryption
  oauth/                     signed state, Google client, token store + refresh
  auth/                      GET /auth/google, /auth/google/callback  [gateway]
  agents/calendar/           ← the calendar agent, self-contained
    calendar-agent.service.ts  orchestrator; single entry point `handle(job)`
    intent/                    wire schema, Anthropic classifier, keyword filter
    google/                    CalendarClient port + googleapis impl
    conflict/                  overlap detection
    pending-action/            confirmation store + reply interpretation
prisma/                      schema + migrations
test/
  harness.ts                 Phase 1 boot/reset helpers
  calendar-harness.ts        Phase 2 harness — binds the four fakes
  fakes/                     FakeCalendarClient, ScriptedIntentClassifier, …
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

## What the next phase plugs into

- **Add an agent** as a sibling of `src/agents/calendar/`, exposing the same
  single `handle(job)` entry point. `CalendarAgentService` is shaped so the
  future router calls every agent identically.
- **Replace the keyword pre-filter** in `TelegramMessageProcessor` with real
  routing across agents. The gateway needs no changes.
- Consume `TelegramMessageJobV1` from `src/common/contracts/`. Key all per-user
  state off `tenantId`, never the Telegram id.
- Swapping BullMQ for SQS means adding one `QueueService` implementation and
  changing the `useClass` in `src/queue/queue.module.ts`. The same applies to
  the LLM (`CalendarIntentClassifier`) and the Calendar API (`CalendarClient`).

See `DECISIONS.md` for the judgment calls behind all of this.
