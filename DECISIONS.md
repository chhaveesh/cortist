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

---

# Phase 2 — Calendar agent

## 20. AES-256-GCM, not KMS

**Chosen: AES-256-GCM with a key from `TOKEN_ENCRYPTION_KEY`.**

The spec said KMS if AWS credentials were available. They are not — no `~/.aws`,
no `AWS_*` environment — so envelope encryption via KMS would have been
untestable here and unrunnable by anyone cloning the repo.

GCM rather than CBC because it authenticates: a tampered row fails to decrypt
instead of yielding attacker-influenced plaintext. A fresh random 96-bit IV per
encryption is mandatory — reusing one under the same key leaks the keystream and
breaks GCM outright, which is why `encrypt()` never accepts a caller-supplied IV
and a test asserts two encryptions of the same input differ.

The envelope is `v1:<iv>:<tag>:<ciphertext>`. The version prefix means a future
move to KMS can decrypt existing `v1` rows during migration instead of orphaning
them — the natural upgrade path is a `v2` prefix holding a KMS-wrapped data key.

Rotating the key makes every stored token undecryptable and forces all users to
reconnect. That is documented in `.env.example` rather than mitigated: key
rotation with re-encryption is a real feature, and pretending otherwise would be
worse than saying so.

## 21. Claude Haiku 4.5 for intent parsing

**Chosen: `claude-haiku-4-5` via the Anthropic SDK.**

No LLM provider was configured, so this was a free choice. Haiku 4.5 is cheap
($1/$5 per MTok), fast enough to sit in a message path, supports structured
outputs, and keeps the project on one vendor. The spec named `gpt-4o-mini` "or
equivalent"; this is the equivalent.

Cost is bounded by design: one classification per message that survives the
pre-filter, at ~500 input tokens. `max_tokens` is 2048 — this is extraction of a
few short strings, and a low ceiling stops a runaway generation.

The provider sits behind `CalendarIntentClassifier`, so switching is one new
implementation and a changed `useClass`.

## 22. Flat wire schema, narrowed to a domain union

The model fills a **flat object** with every field required; the agent works
with a **discriminated union**. `narrowIntent()` bridges them.

Sending the union directly was the obvious approach and was rejected. Structured
outputs supports `anyOf`, but a flat all-required object is markedly more
reliable for a small model, and it degrades better: a model that fills the wrong
field for its chosen intent produces a validation miss we can turn into a
clarifying question, rather than a schema violation that fails the whole call.

The union is still where correctness lives — `narrowIntent` enforces the
per-intent required fields the flat schema cannot express, so invalid
combinations never reach the agent. When a required field is missing, it
**downgrades to `needs_clarification` rather than guessing**. Guessing a time or
a title is exactly how you end up with a wrong entry in someone's real calendar
that they have to notice and undo.

**Two schema declarations, cross-checked.** The SDK's `zodOutputFormat` helper
targets Zod v4; this project is on Zod v3, which Phase 1 uses throughout.
Upgrading Zod under working code for one call site was not worth it, so the wire
contract is written as literal JSON Schema (`jsonSchemaOutputFormat`) and Zod
validates the response. `calendar-intent.schema.spec.ts` asserts the two agree
on field names, required-ness, and the absence of constraint keywords that
structured outputs rejects — so they cannot drift silently.

## 23. The model never sees an event id

For reschedule and delete the model emits an `eventQuery` (title words plus a
time window); we resolve it against the real calendar.

This is what makes *"reschedule my call"* work when the user has three calls
today. Resolution has three outcomes — none, one, several — and only the middle
one proceeds. Several produces a numbered list and a question. A model asked to
produce an id would have had to invent one.

## 24. Timezone from the events.list response

`events.list` returns the calendar's `timeZone`, so relative phrases resolve
correctly without requesting `calendar.settings.readonly` on top of
`calendar.events`. One fewer scope on the consent screen, for a field we were
already fetching.

## 25. Pending actions in Postgres, resolved before confirmation

**Chosen: a `pending_actions` table, unique on `user_id`.**

Redis with a TTL was the alternative and would have been less code. Postgres was
chosen for durability and inspectability: an unanswered confirmation surviving a
Redis restart is the safer failure direction, and being able to query what a
tenant was asked is worth having. Expiry is enforced **on read** rather than by a
sweeper, so a delayed cleanup can never resurrect a stale confirmation.

**The event id is resolved before the record is written, not after the "yes".**
If we stored only the user's words and resolved them on confirmation, a calendar
that changed in between could make "yes" delete a different event than the one
named in the prompt.

Unique on `user_id` means a new request supersedes an unanswered one. If a user
asks to delete A, then asks to delete B, their "yes" clearly refers to B.

**Deciding what supersedes uses the classifier, not the keyword filter.** The
first implementation gated this on `looksCalendarRelated()`, which was wrong: the
filter is a recall-tuned heuristic, and letting a false positive discard a
pending confirmation hangs a destructive-action decision on a guess. It was
caught by the filter matching "maybe" (see §26). Now an unclear reply is
classified properly, and only an actionable intent supersedes.

Confirmation replies are interpreted **deterministically**, not by the LLM: the
ways people say yes and no form a small closed set, the user is waiting, and a
model that hallucinated "affirmative" would delete a real event. Negatives are
checked before affirmatives, so *"no, cancel it"* — which contains the
affirmative phrase "cancel it" — reads as a refusal. On a destructive action the
safe misreading is to decline.

## 26. The keyword pre-filter, and what it costs

A regex pre-filter runs before the LLM call. This was a deliberate choice against
the recommendation, and the tradeoff is real: it saves one small model call per
non-calendar message, at the cost of silently dropping any calendar request
phrased without a listed keyword. **Recall is the side that fails invisibly** —
the user just gets no reply.

Two mitigations: the list is generous (verbs, nouns, weekdays, months, time
expressions), and `calendar-keyword-filter.spec.ts` has a test that explicitly
pins three known false negatives so the blind spot is visible in review rather
than discovered in production.

**A false-positive bug found in review.** The month pattern was
`(jan|feb|mar|…|may|…)[a-z]*` — a prefix match that also fires on "maybe",
"decide", "separate", "market", and "jungle". It surfaced when "hmm maybe"
matched and discarded a pending delete confirmation. Fixed by listing month
names and abbreviations explicitly, with a regression test. The deeper lesson is
recorded in §25: the filter is not a signal to hang decisions on.

The general router in a later phase replaces this outright.

## 27. Create executes; delete and reschedule confirm

The spec asked whether create-without-confirmation is reasonable. It is.

Creating is additive, conflict-checked, and trivially undone, and the summary
sent afterwards makes a mistake immediately visible. Deleting destroys data.
Rescheduling moves a commitment other people may have planned around — which is
why it is gated too, rather than treated as a benign edit.

Conflict detection uses **half-open intervals**: an event ending exactly as
another begins does not clash, because back-to-back meetings are normal and
flagging them would make the agent unusable for anyone with a full day. All-day
events are ignored — treating a "Public Holiday" as a conflict would block every
booking that day. A rescheduled event is excluded from its own conflict check,
or it would always clash with its current slot.

## 28. Agent before marker in the worker

`TelegramMessageProcessor` dispatches to the agent **first**, then writes the
`processed_messages` row.

Marker-first would let the `P2002` duplicate branch short-circuit a retry and
skip the agent entirely, silently dropping the message. Agent-first is safe
because `CalendarAgentService` rethrows **only** on `rate_limited` — and a
rate-limited call never executed, so a retry cannot duplicate an event. Every
other calendar failure returns an outcome instead of throwing, so it never
triggers a BullMQ retry at all. Create is the only non-idempotent operation, and
that is precisely the path a rate limit leaves untouched.

The marker write stays: it is idempotency layer 3 from §4 and the assertion
target for the Phase 1 pipe tests.

## 29. Test doubles at four provider tokens

`test/calendar-harness.ts` overrides `CalendarClient`,
`CalendarIntentClassifier`, `GoogleOAuthClient`, and `TelegramSenderService`.

Those are the code's only routes to Google, Anthropic, and Telegram, so "no real
network calls in CI" is a structural property rather than a testing convention —
reaching the network would require deliberately binding the real implementations
back. No API key, bot token, or tunnel is needed to run the suite.

The scripted classifier **throws on an unscripted call** rather than returning a
default: an unexpected classification means the agent took a path the test did
not anticipate, and silently absorbing that would hide real regressions.

Assertions are written around what the user was *told*, not only what was stored.
A test that checked "no event was created" would pass even if the agent silently
did nothing, which is a bad experience dressed up as correct behaviour.

The Phase 2 harness is separate from Phase 1's so the existing webhook, pipe,
and shutdown suites keep exercising unmodified wiring.

## 30. `isolatedModules` for the test tiers

Pulling the googleapis type tree into ts-jest pushed the unit suite from ~3s to
~45s, which defeats the point of a fast tier the walkthrough expects to "take
seconds". Per-file transpilation brings it back to ~1s. Whole-program type
checking still happens — via `tsc --noEmit` and `npm run lint`, both of which run
in the verification pass.

## 31. A network guard, because the guarantee was wrong once

`test/network-guard.ts` wraps `fetch` and the `http`/`https` modules and fails
any test that reaches a non-localhost host.

The four provider overrides in §29 were supposed to make external calls
impossible. They did not: the Phase 1 e2e pipe test boots the **real**
`WorkerAppModule`, and once the calendar agent was wired into the worker, that
module graph included the real `TelegramSenderService`. The suite made a genuine
request to `api.telegram.org` and got a 404 from the placeholder test token,
which surfaced only as "timed out waiting for the processed_messages row" — a
failure that pointed nowhere near the actual cause.

Two fixes came out of it. The e2e worker boot now stubs the same outbound seams
the Phase 2 harness does. And the guard turns "no real network calls" from a
claim that has to be re-verified by reading code into a property the suite
enforces on every run, with an error naming the host and the fix.

The guard has its own tests. An untested guard is worse than none — it produces
confidence without justification, which is precisely the failure it exists to
prevent. Writing them found two bugs in it: a naive `/:\d+$/` port strip mangled
IPv6 `::1` into `:`, and the `fetch` wrapper threw synchronously instead of
rejecting, which does not match `fetch` semantics.

## 32. Phase 2 credentials are optional

Making them required meant a missing `GOOGLE_CLIENT_ID` **crash-looped the
gateway**. The Telegram webhook went down with it, so Telegram retried and
eventually dropped messages — losing user input because a *calendar* credential
was absent from a path that never touches the calendar.

Fail-fast on config is right in general (§ Phase 1 env validation), but the
blast radius has to match. Ingestion is Phase 1 functionality and must not be
held hostage to Phase 2 setup. Now:

- The gateway, queue, and worker start and run normally.
- `CalendarConfigService` warns once at boot naming every absent variable.
- A calendar request gets an honest "this isn't configured on my side" reply
  rather than silence, and nothing touches Google or Anthropic.
- `/health` reports `calendar: not_configured` with the missing names.

**`/health` still returns 200 in that state**, deliberately. An unconfigured
calendar is a setup state, not an outage; a 503 would pull a gateway that is
happily accepting and queueing messages out of load-balancer rotation, which is
the opposite of what the operator wants.

All-or-nothing on the credential set: a half-configured integration (a Google
client but no encryption key) fails deep inside a request with a confusing
error. Format is still validated when a value *is* supplied — an 8-character
encryption key is a mistake worth failing on; an absent one is a choice.

## 33. Two concurrency findings

Found by writing the tests the Phase 2 walkthrough asked for, and neither was
what I expected.

**Fixed — double execution of a confirmed destructive action.** The confirmation
path did `get()` then `clear()`, which is check-then-act. Two concurrent "yes"
replies (a double-tap, or a retried job) both read the pending row before either
cleared it, and **both went on to delete**. My own comment in the code claimed
this was safe; the test proved it was not. Replaced with `claim()`, which uses
Postgres `DELETE … RETURNING` so exactly one caller wins; the loser gets a
benign outcome.

**Documented, not fixed — same-slot double booking.** Conflict detection reads
the calendar and then writes with no lock between. Under ordinary interleaving
the first write lands before the second read, so the clash is caught — and a
test asserts that. But that test proves nothing about safety; it passes because
the scheduling happened to serialise. A second test holds the write open so both
reads complete first, and **both creates succeed**, demonstrating the race
deterministically rather than hoping a scheduler reveals it.

Exposure is limited but real: Phase 1 dedupes identical messages and a single
user's jobs usually run one at a time, but `WORKER_CONCURRENCY` is 5 and nothing
pins a tenant to a worker. The fix is a per-tenant advisory lock
(`pg_advisory_xact_lock` on a hash of the tenant id) around read-then-write, or a
uniqueness constraint on the slot. Deferred to Phase 3 and pinned by a test that
should be *updated* when fixed, not deleted.

## 34. The intent evaluation script

`npm run eval:intent` runs fixtures through the **real** Anthropic API and prints
what came back.

The automated suite uses a scripted classifier, which is what keeps CI offline
and deterministic — but it means the model's actual judgement is never
exercised. Specifically: whether it *asks* instead of guessing on "book
something for 9" (9am or 9pm?), or resolves "next Tuesday" to the right date.
Those are the failures that put a wrong entry in someone's real calendar, and no
mock can catch them.

The script is deliberately outside CI: it costs money, needs a key, and its
ambiguous cases are judgement calls rather than invariants. Clear fixtures fail
the run; ambiguous ones (`≈`) report and never fail, because reasonable people
disagree about them and the output is there to be read. It also flags when the
keyword pre-filter would have dropped a fixture before the model ever saw it —
a class of failure the model cannot be blamed for and that is otherwise
invisible.

---

## Still deferred after Phase 2

Recurring-event editing (the client expands instances via `singleEvents`, but
editing a series is not modelled); attendee invitations and responses; free/busy
negotiation beyond detect-and-report; multiple calendars per user (everything
targets `primary`); a general multi-agent router; key rotation with
re-encryption. The Phase 1 deferrals — rate limiting, a dead-letter queue with
alerting, structured JSON logging with trace correlation, and non-text message
handling — all still stand.
