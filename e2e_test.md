# Cortist — end-to-end test guide

How to exercise this repo from a cold checkout all the way to a real Telegram
bot talking to a real Google Calendar and a real second brain.

Five tiers, in increasing order of what they cost you. Tiers 0–2 need **no
credentials at all**. Stop wherever you like — each tier is independently
useful.

| Tier | What it proves | Needs |
| --- | --- | --- |
| 0 | Pure logic: schemas, filters, crypto, chunking, ambiguity, durations | Node 20+ |
| 1 | The whole suite against real Postgres + Redis | Docker |
| 2 | A live stack: ingest, dedupe, retry, shutdown, health | Docker |
| 3 | What the *model* actually does (the mocks can't test this) | An LLM key |
| 4 | Real Telegram + real Google + real documents | everything |

---

## Run log

Results from a full pass on **2026-07-23** (branch `phase-2-calendar-agent`,
macOS, Node 22.14, Docker 27.3.1, `LLM_PROVIDER=gemini`).

| Tier | Result | Detail |
| --- | --- | --- |
| 0 — unit | ✅ passed | 22 suites / 422 tests / ~3s |
| 1 — dockerized suite | ✅ passed | 45 suites / 594 tests, exit 0 |
| 2 — live stack | ✅ passed | every check below |
| 3 — model behaviour | ✅ passed | routing, extraction, and ambiguity verified against the live API |
| 4 — real integrations | ✅ passed | OAuth, query, search, create, duration prompt, conflict, reschedule, delete, **decline**, and RAG all verified against real Google. |

Tier 1 breakdown:

| Sub-tier | Suites | Tests |
| --- | --- | --- |
| Unit | 22 | 422 |
| Integration | 18 | 156 |
| End-to-end | 5 | 16 |

All four migrations applied cleanly to the isolated test database
(`init` → `calendar_agent` → `rag_agent` → `intent_router`), including the
pgvector extension and the HNSW index. Teardown left no containers behind and
the dev stack was untouched.

### What this pass found

Nine defects, all found by running the thing rather than by reading it. Eight
fixed, one open.

| # | Defect | How it surfaced | Status |
| --- | --- | --- | --- |
| 1 | `/health` reported `calendar: configured` on pure `.env.example` placeholders | Tier 2, first `curl` | fixed |
| 2 | Router threw `401` into a retry loop instead of degrading; the user was told nothing and no `processed_messages` row was written | Tier 2, first actionable message | fixed |
| 3 | `npm run eval:intent` had been broken since Phase 4a — imported a file the refactor deleted | typecheck while porting | fixed (script removed, fixtures folded into `eval:router`) |
| 4 | "what's on my calendar tomorrow?" routed to `unrelated`, so the README's own onboarding step could never send an OAuth link | Tier 4, first real message | fixed (`query_events`) |
| 5 | Ambiguity over-triggered when the runner-up was `unrelated`, producing an unanswerable question | Tier 4, real conversation | fixed |
| 6 | Non-retryable provider errors (400 credit balance, 401 bad key) burned all three retries silently | Tier 4, exhausted API credit | fixed |
| 7 | "move it to 5pm" moved a Friday event to Thursday — the classifier never sees the event, so a bare time anchored to today | Tier 4, real reschedule | fixed (`newDateGiven` + agent-side rebase) |
| 8 | Every "today" was a day behind after 18:30 IST: the model was sent a **UTC** timestamp and asked to convert | Tier 4, after a model switch | fixed (`formatZonedNow`) |
| 9 | A calendar reporting no timezone got a hardcoded `'UTC'`, cached permanently on the user row — every "11:30am" landed at 17:00 | Tier 4, second Google account | fixed (+ `TIMEZONE_OVERRIDE`) |

Two of those are worth dwelling on:

- **#8 was latent.** `gemini-flash-latest` did the UTC→local arithmetic
  correctly; `gemini-flash-lite` did not. The correctness of every date in the
  system depended on model strength rather than on code, and would have broken
  silently on any model change. The fix removes the arithmetic entirely.
- **#9 cached a guess.** The hardcoded fallback was indistinguishable from a
  real answer once stored, so nothing could ever detect it. The rule that came
  out of it: *never cache a fallback*.

### Also built during this pass

- **Gemini provider** (`LLM_PROVIDER=gemini|anthropic`), chosen at boot in
  `router.module.ts` and `rag-agent.module.ts`. Gemini's `responseJsonSchema`
  accepts the existing JSON Schemas verbatim, so there is no translation layer.
  This is the first thing to actually exercise the `RouteClassifier` port
  abstraction, which until now was an untested claim.
- **`query_events`** — "what's on my calendar?", with an optional search term so
  "when is Sam's birthday?" searches a year instead of listing today.
- **The duration prompt** — a create with no stated duration asks *"How long is
  X?"* with tappable 30 minutes / 1 hour / 2 hours, instead of silently
  assuming an hour.
- **`TIMEZONE_OVERRIDE`** — pins one timezone for every user. A blunt
  instrument for single-region deployments; see Known gaps.

Alarming-looking log lines that are **expected**, not failures:

- `Failed to parse PDF fake.pdf / broken.pdf: Invalid PDF structure` —
  `extractors.spec.ts` feeding deliberately malformed bytes.
- `Readability found no article … using body text` — the documented fallback.
- `Calendar agent is DISABLED — missing: …` — `calendar-config.spec.ts`
  asserting the degraded-config path.
- `Rejected OAuth callback with an invalid state signature` ×3 — the forgery,
  expiry, and clock-skew cases.

---

## Before you start

```bash
node -v          # must be >= 20
docker -v && docker compose version
cp .env.example .env
npm install
```

**Check for port conflicts.** The dev stack publishes Postgres and Redis on
5432/6379 and the gateway on 3000; the test stack uses 55432/56379.

```bash
lsof -nP -iTCP:5432,6379,3000,55432,56379 -sTCP:LISTEN
```

Anything listed is a conflict. The Postgres and Redis host ports are only for
your convenience (psql/redis-cli) — the services always reach each other over
the compose network — so remap freely in `.env`:

```bash
POSTGRES_HOST_PORT=5433
REDIS_HOST_PORT=6380
```

---

## Tier 0 — unit tests (~3 seconds, no Docker)

```bash
npm test
```

Expect **22 suites / 422 tests passed**. Covers the payload contract,
idempotency semantics, AES-256-GCM round-trip and tamper rejection, OAuth state
forgery and expiry, conflict-overlap maths, both keyword pre-filters,
confirmation / clarification / duration reply parsing, timezone formatting,
provider selection, retry classification, chunking, extractors, and the network
guard itself.

If this fails, nothing below is worth running.

---

## Tier 1 — the full dockerized suite (no credentials)

```bash
npm run test:e2e            # unit + integration + e2e
```

Tiers individually:

```bash
npm run test:integration
npm run test:e2e:only
```

`scripts/test-stack.sh` creates its own compose project (`cortist-test`) on
ports 55432 / 56379 with tmpfs storage, applies migrations, generates the Prisma
client, runs jest, and tears everything down. Your dev data is never touched.

To keep the containers up while chasing a failure:

```bash
KEEP_TEST_STACK=1 npm run test:e2e
docker compose -p cortist-test -f docker-compose.test.yml down -v   # later
```

**No network is reachable from this tier, structurally.** Google, Anthropic,
Gemini, and Telegram are replaced at their provider tokens by fakes, and
`test/network-guard.ts` fails any test that opens a connection to a
non-localhost host.

> **`.env.test` must set every variable it depends on, explicitly.** Nest loads
> `.env` *alongside* `.env.test`, so anything unset there silently inherits your
> personal value — which broke the timezone tests twice during this pass, once
> via `DEFAULT_TIMEZONE` and once via `TIMEZONE_OVERRIDE`. Blank it (`VAR=`)
> rather than omitting it.

---

## Tier 2 — a live local stack (still no credentials)

```bash
docker compose up -d --wait
```

### 2.1 Health

```bash
curl localhost:3000/health
```

With placeholder credentials expect **200** and:

```jsonc
{"status":"ok","redis":"connected","postgres":"connected",
 "calendar":"not_configured","calendarMissing":[],
 "calendarPlaceholder":["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","GEMINI_API_KEY"],
 "router":"not_configured","routerPlaceholder":["GEMINI_API_KEY"]}
```

Note `calendarPlaceholder` vs `calendarMissing`: a variable you can plainly see
in your `.env` is never reported as missing. An unconfigured calendar is a setup
state, not an outage — the gateway stays in rotation on purpose.

### 2.2 Ingest a simulated Telegram delivery

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
```

Expect `{"ok":true,"status":"enqueued"}`.

### 2.3 Deduplication

POST the **identical** payload again → `{"ok":true,"status":"duplicate"}`, still
200, no second job.

```bash
docker compose exec redis redis-cli KEYS 'cortist:dedupe:*'
```

### 2.4 Rejection paths

```bash
# wrong secret → 401
curl -i -X POST localhost:3000/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong' -d '{}'

# malformed body → 400, nothing enqueued
curl -i -X POST localhost:3000/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: local-dev-webhook-secret' \
  -d '{"update_id":"not-a-number"}'
```

### 2.5 The worker picked it up

```bash
docker compose logs -f worker
# [TelegramMessageProcessor] Processing message 777001 … "…"
# [TelegramMessageProcessor] Router outcome for message 777001: <status>
```

### 2.6 It reached Postgres

```bash
docker compose exec postgres psql -U cortist -d cortist \
  -c 'SELECT tenant_id, chat_id, message_id FROM processed_messages;' \
  -c 'SELECT id, telegram_user_id, time_zone FROM users;'
```

### 2.7 Health failure path

```bash
docker compose stop postgres
curl -i localhost:3000/health     # 503, postgres: disconnected, failures[]
docker compose start postgres
curl -i localhost:3000/health     # 200 once it recovers
```

### 2.8 Graceful shutdown

```bash
docker compose stop worker                     # sends SIGTERM
docker compose logs worker | grep Shutdown
docker compose exec redis redis-cli LLEN bull:telegram-messages:active   # 0
docker compose start worker
```

### 2.9 Retry and failure policy

3 attempts, exponential backoff from 2s, then the failed set (retained 24h,
never silently dropped).

```bash
docker compose exec redis redis-cli ZCARD bull:telegram-messages:failed
docker compose logs worker | grep -Ei 'retry|attempt|failed'
```

> **Expected on this tier:** an actionable message gets an honest *"missing some
> configuration on my side"* reply rather than vanishing — that reply then fails
> to send, because a placeholder `TELEGRAM_BOT_TOKEN` gets a 404 from the Bot
> API. Chit-chat is pre-filtered and costs nothing. Nothing here needs a real
> key; Tier 3 does.

---

## Tier 3 — what the model actually does

Needs a real key for whichever provider `LLM_PROVIDER` names.

```bash
npm run eval:router               # routing + extraction fixtures
npm run eval:router -- ambiguous  # only the ambiguous ones
```

The script mirrors the runtime binding, so it evaluates whichever provider the
deployment actually uses. It prints each fixture's route, the extracted intent
(title, start time, duration), and the model's own **reasoning** — read the
reasoning, not just the labels. A right answer for a wrong reason is worth
catching before it becomes a wrong answer. It also flags any fixture the keyword
pre-filter would have dropped before the model ever saw it.

The automated suite uses a **scripted** classifier, so the model's judgement is
never exercised by CI. That matters most for one property: whether it asks
instead of guessing. `"book something for 9"` — 9am or 9pm? A guess puts a real
event in someone's calendar at the wrong time, and no mock can catch it.

> `npm run eval:intent` no longer exists. Phase 4a merged routing and extraction
> into one call, and the script still imported the classifier that refactor
> deleted — it had been failing to compile since. Its distinctive fixtures now
> live in `eval:router`, which already prints extracted titles and times.

---

## Tier 4 — real Telegram, real Google, real documents

Deliberately not automated. This is the one-time check that the real clients,
real OAuth, and real Telegram wiring work together.

### 4.1 Expose the gateway

```bash
ngrok http 3000
```

Set both to the tunnel URL and rebuild:

```
PUBLIC_BASE_URL=https://<your-tunnel>
GOOGLE_REDIRECT_URI=https://<your-tunnel>/auth/google/callback
```

The redirect URI must **also** be registered on the Google OAuth client
character for character — scheme, host, port, path. A trailing slash fails.

```bash
docker compose up -d --build --wait
curl localhost:3000/health     # must now say "calendar":"configured"
```

### 4.2 Register the webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<your-tunnel>/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"

curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# want: pending_update_count 0, no last_error_message
```

### 4.3 Connect a calendar

Message the bot: **"what's on my calendar tomorrow?"**

It replies with a link carrying a signed, short-lived `state` parameter (15 min).
Follow it, click through **Advanced → Go to … (unsafe)** — expected for an
unverified Testing-mode app — and consent. You should land on "Calendar
connected" and get a Telegram confirmation.

```bash
# tokens must be encrypted at rest: a v1:… envelope, never a readable token
docker compose exec postgres psql -U cortist -d cortist \
  -c 'SELECT left(access_token_encrypted,20), left(refresh_token_encrypted,20) FROM oauth_tokens;'

# the calendar's timezone should now be cached against the user
docker compose exec postgres psql -U cortist -d cortist \
  -c 'SELECT telegram_user_id, time_zone FROM users;'
```

> A `UTC` here for a user who is not in UTC means Google reported no timezone
> for that calendar. Fix it at the source (Google Calendar → Settings → Time
> zone), or pin `TIMEZONE_OVERRIDE`.

### 4.4 Calendar walkthrough

| # | Say | Expect |
| --- | --- | --- |
| 1 | "what's on my calendar tomorrow?" | The day's events as `start–end` ranges, or "nothing on your calendar between …" |
| 2 | "book a dentist appointment tomorrow at 3pm **for an hour**" | Created directly. Check Google Calendar shows 3pm **in your own timezone** |
| 3 | "add a gym session at 11:30 tomorrow" *(no duration)* | Asks **"How long is …?"** with tappable 30 minutes / 1 hour / 2 hours. **Nothing is created yet** |
| 4 | tap **30 minutes** | Now created, 11:30–12:00 |
| 5 | ask for another event overlapping the dentist | Refusal naming the clash, and **no** second event |
| 6 | "move my dentist appointment to 5pm" | Asks first, naming **both** times. Verify the calendar is unmoved, then reply "yes" → moves, duration preserved |
| 7 | "cancel my dentist appointment" → **"no"** | **Event survives** — verified against real Google (see below) |
| 8 | ask again → **"yes"** | Event gone |
| 9 | "when is Sam's birthday?" | Searches a **year** by name — not a list of today's events |
| 10 | "reschedule my call" with three calls | Lists them and asks which |

Step 6 is worth doing carefully: the confirmation names the old *and* new time,
and that is the only reason defect #7 above was catchable rather than a silent
corruption.

**The decline path (step 7), verified 2026-07-23.** "cancel the doctor
appointment" → *`Delete "doctor appointment" … Reply "yes" to confirm`* → "no".
Three independent checks confirmed the event survived:

- The worker logged `Calendar follow-up … : declined`. No `deleteEvent` call
  and no `Deleted` confirmation followed — Google was never touched.
- `pending_actions` was empty afterwards: "no" *consumed* the pending delete
  rather than stranding it to expire or leaving it live for a stray later "yes".
- "no" was handled by the follow-up path **before** classification, logged as
  `follow_up`, never reaching the model. A bare "no" classifies as `unrelated`,
  so the pending-confirmation check must run first, or every decline would
  strand its action (DECISIONS.md §25). That ordering held under real
  conditions.

Two behaviours that are **by design**, not bugs:

- **Creating executes without asking.** It is additive, conflict-checked, and
  trivially undone, and the confirmation sent afterwards makes a mistake visible
  immediately. Only delete and reschedule — which destroy data or move a
  commitment others planned around — require an explicit "yes".
- **"what is the date today?"** gets "I can help with your calendar and saved
  documents". It is not a calendar action.

### 4.5 Routing and ambiguity

| Say | Expect |
| --- | --- |
| "remind me about the Q3 report" | Asks: calendar, or your saved documents? |
| "create a calendar event to review the Q3 report tomorrow at 3pm" | Routes straight to calendar — **must not** ask |
| answer the clarifying question | Resolves and dispatches; it never asks twice |
| ignore it for >3 min, then reply | The question has expired (`CLARIFICATION_TTL_SECONDS`) |
| "what's the API rate limit?" | Routes to your documents — **must not** ask "or something else?" |

Over-triggering is a failure mode in its own right, not a safe default. The last
row is defect #5: a runner-up of `unrelated` is not a choosable alternative, and
asking about it cost three messages to answer a question already routed
correctly.

### 4.6 The second brain (RAG)

1. **Upload a real PDF.** Expect a reply naming the file, a summary, and 2–3
   tags within a few seconds.
2. **Check it stored:**
   ```bash
   docker compose exec postgres psql -U cortist -d cortist \
     -c 'SELECT source_name, tags, left(summary,60) FROM documents;' \
     -c 'SELECT count(*) FROM document_chunks;'
   ```
3. **Ask something you know the answer to** — the answer must be correct *and*
   cite the right filename.
4. **Ask something the document does not cover** — "what does it say about
   penguins?". It must say it found nothing. If it invents an answer,
   `RAG_SIMILARITY_THRESHOLD` is too low for this embedding model.
5. **Save a URL**, then ask about it, and check the stored text is the article
   rather than nav and footer:
   ```bash
   docker compose exec postgres psql -U cortist -d cortist \
     -c "SELECT left(content,200) FROM document_chunks ORDER BY created_at DESC LIMIT 1;"
   ```
6. **Plain text** — "save this: the API limit is 1000/min", then ask about it.

### 4.7 Token refresh

Google access tokens last about an hour. Leave the stack alone for longer, then
send another calendar message. It should just work:

```bash
docker compose logs worker | grep Refreshing
```

Revoking the app in your Google account should produce a "reconnect" prompt
rather than a retry loop.

---

## Credentials checklist

Everything lives in `.env`. Nothing else is external — embeddings run locally
(all-MiniLM-L6-v2, baked into the image) and vectors live in the same Postgres.

- [ ] **An LLM key**, matching `LLM_PROVIDER`:
      - `gemini` → **`GEMINI_API_KEY`** from
        <https://aistudio.google.com/apikey>. No card required.
      - `anthropic` → **`ANTHROPIC_API_KEY`** from
        <https://console.anthropic.com/settings/keys>. Needs credit on the
        workspace — a Claude subscription does **not** include API credit.
- [ ] **`TELEGRAM_BOT_TOKEN`** — [@BotFather](https://t.me/BotFather) →
      `/newbot`. Needed for every outbound reply and to download uploaded PDFs.
- [ ] **`TELEGRAM_WEBHOOK_SECRET`** — `openssl rand -hex 32`, and pass the same
      value to `setWebhook`. Setting it here alone means Telegram gets 401s.
- [ ] **`PUBLIC_BASE_URL`** — the tunnel URL, reachable by Telegram and by your
      browser. Not a compose service name.
- [ ] **Google Cloud** — project → enable **Google Calendar API** → OAuth
      consent screen (External) → **Data access**: add scope
      `https://www.googleapis.com/auth/calendar.events` → **Audience**: add
      yourself under **Test users** → Credentials → OAuth client ID → **Web
      application** → redirect URI exactly `<PUBLIC_BASE_URL>/auth/google/callback`.
      Copy into `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- [ ] **`TOKEN_ENCRYPTION_KEY`** — `openssl rand -hex 32` (exactly 64 hex chars).
      Rotating it makes every stored token undecryptable.
- [ ] **`OAUTH_STATE_SECRET`** — `openssl rand -hex 32`.

### On the Gemini free tier

`GEMINI_MODEL` defaults to **`gemini-flash-lite-latest`**, and that default is
deliberate: `gemini-flash-latest` currently resolves to a model allowing **20
requests per day** on the free tier, which a single testing session exhausts.
Flash-lite's allowance is far higher.

Aliases rather than pinned versions (`gemini-2.5-flash`) because pinned names
return 404 for keys created after those models closed to new signups. The cost
is that the model can change under the alias — `npm run eval:router` is how that
gets caught.

Enabling billing on the key's Google Cloud project switches it to paid rate
limits, and **removes the free tier entirely**. A Google Cloud trial credit does
not automatically apply — the API key's own project must have the billing
account linked.

### Optional, but worth setting explicitly

```bash
DEFAULT_TIMEZONE=Asia/Kolkata     # default UTC — silently wrong event times
TIMEZONE_OVERRIDE=Asia/Kolkata    # pins EVERY user; see Known gaps
CLARIFICATION_TTL_SECONDS=180
PENDING_ACTION_TTL_SECONDS=300
WORKER_SHUTDOWN_TIMEOUT_MS=10000
RAG_TOP_K=5
RAG_SIMILARITY_THRESHOLD=0.3
```

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `docker compose up` fails binding a port | 5432/6379/3000 in use — set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` / `PORT` |
| `/health` says `not_configured` with `…Placeholder` populated | The named variables still hold `.env.example` values |
| Bot replies "missing some configuration on my side" | The active provider's API key is absent or a placeholder — `/health` names it |
| Bot replies "I'm being rate limited right now" | Provider quota; the wait it names came from the provider itself |
| `Quota exceeded … limit: 20, model: gemini-3.6-flash` | Free-tier daily cap on `gemini-flash-latest` — use `gemini-flash-lite-latest` or enable billing |
| `credit balance is too low` (Anthropic 400) | API credit is separate from a Claude subscription |
| Calendar replies fail but ingestion works | Placeholder `TELEGRAM_BOT_TOKEN` — the Bot API returns 404 |
| Telegram delivers nothing | `secret_token` at `setWebhook` doesn't match `TELEGRAM_WEBHOOK_SECRET`; check `getWebhookInfo` |
| Google `403 access_denied` | Your account isn't under **Test users** on the consent screen |
| Google `redirect_uri_mismatch` | Registered URI differs — trailing slash, or `127.0.0.1` vs `localhost` |
| Events land hours off | The user's `time_zone` row is wrong (often `UTC`). Fix in Google Calendar settings, or set `TIMEZONE_OVERRIDE` |
| A message gets no reply at all | The keyword pre-filter dropped it — `docker compose logs worker \| grep Pre-filtered` |
| RAG answers confidently from nothing | `RAG_SIMILARITY_THRESHOLD` too low for the embedding model |
| Integration tests fail on `CREATE EXTENSION vector` | Wrong Postgres image — must be `pgvector/pgvector:pg16` |
| A test passes locally but fails in the suite (or vice versa) | `.env` leaking into `.env.test` — set the variable explicitly, even if blank |

---

## Known gaps

Worth knowing before you file a bug against them.

**Untested**

- **`event_not_found` on phrasings that should resolve.** "shift meeting from
  11 am to 9 am" failed to find a meeting that existed. Seen once in real logs,
  not yet reproduced or diagnosed.

*(The decline path — "cancel" → "no" → the event survives — was the other entry
here until 2026-07-23, when it was verified against real Google. See the Tier 4
walkthrough.)*

**Real limitations**

- **`TIMEZONE_OVERRIDE` is a blunt instrument.** It pins every user to one zone
  and is simply wrong for anyone outside it. The real fix is a reliable per-user
  timezone with a way for the user to correct it (`set my timezone to …`).
  `/health` reports the override so a pinned deployment is never a mystery.
- **Only the `primary` calendar is read.** Google keeps contact birthdays in a
  separate "Birthdays" calendar, so "list all my birthdays" finds only events
  you created yourself. Multi-calendar support is a documented deferral.
- **The keyword pre-filter is miscalibrated in both directions.** It passes
  "what is the capital of France?" to the model (costing a call) and dropped
  "list all the birthdays saved in my calender" entirely (costing a reply)
  because of one misspelling. Common misspellings are now covered; the general
  problem is not solved, and a drop is silent by nature.
- **A placeholder `TELEGRAM_BOT_TOKEN` is retried like a transient failure.**
  The same category error the router fix addressed, one layer out: a 404 from a
  nonexistent token cannot succeed on attempt two. Unlike the router there is no
  honest fallback — without a token there is no way to tell the user anything —
  but it could fail once rather than three times.
- **`/health` has no field for the RAG agent.** `router` and `calendar` report
  honestly; RAG's own LLM dependency is covered only indirectly.
- **Only `document` uploads are handled.** Photos, voice, and video are
  acknowledged and dropped.

**Deferred by design** — compound multi-step instructions (Phase 4b), task and
email agents, per-agent routing metrics, webhook rate limiting, a dead-letter
queue with alerting, structured JSON logging with trace correlation,
recurring-series editing, attendees, multiple calendars, encryption-key
rotation, OCR, document listing/deletion over Telegram, and reranking. See
`DECISIONS.md`.
