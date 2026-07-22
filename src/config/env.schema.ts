import { z } from 'zod';

/**
 * Single source of truth for process configuration.
 *
 * Parsed once at boot; a malformed environment fails the process immediately
 * rather than surfacing as a confusing runtime error deep in a request path.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  /**
   * Only used by the (future) outbound Telegram client. The gateway never needs
   * it to accept a webhook, which is why the test suite can run without a real
   * bot token.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1),

  /**
   * Shared secret registered with Telegram via setWebhook. Telegram echoes it
   * back in the X-Telegram-Bot-Api-Secret-Token header on every delivery.
   */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),

  /** How long a message id is remembered for deduplication, in seconds. */
  DEDUPE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  /** Worker concurrency — how many jobs a single worker process runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  /**
   * How long a shutting-down worker waits for in-flight jobs before forcing
   * exit. Must stay below the orchestrator's own kill grace period (ECS
   * Fargate's default stopTimeout is 30s) or the platform SIGKILLs us first.
   */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),

  LOG_LEVEL: z
    .enum(['error', 'warn', 'log', 'debug', 'verbose'])
    .default('log'),

  // --- Phase 2: calendar agent ---------------------------------------------
  //
  // Every credential below is OPTIONAL, and that is deliberate. Making them
  // required meant a missing Google key crash-looped the gateway, taking the
  // Telegram webhook down with it — so messages were lost because a *calendar*
  // credential was absent. Ingestion is Phase 1 functionality and must not be
  // held hostage to Phase 2 configuration.
  //
  // When any of them is missing the calendar agent reports itself unconfigured,
  // tells the user, and logs loudly; the gateway, queue, and worker keep
  // running. See `isCalendarConfigured` below.
  //
  // Format is still validated when a value IS supplied — an 8-character
  // encryption key is a mistake worth failing on, an absent one is a choice.

  /**
   * 32-byte AES-256-GCM key, hex-encoded (64 hex chars). Encrypts OAuth tokens
   * at rest. Rotating it makes every stored token undecryptable, forcing users
   * to reconnect — treat it as durable secret material.
   */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
    .optional(),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  /**
   * Must match a redirect URI registered in the Google Cloud console exactly,
   * including scheme, port, and path.
   */
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  /** Signs the OAuth `state` parameter so callbacks cannot be forged. */
  OAUTH_STATE_SECRET: z.string().min(16).optional(),

  /** How long a generated OAuth link stays valid, in seconds. */
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  /**
   * Which LLM backs classification, summarisation, and grounded answering.
   *
   * Exists because the two providers differ in cost by roughly an order of
   * magnitude and Gemini has a genuine no-cost tier, which is what makes the
   * whole system runnable without a card. `RouteClassifier` and `RagLlm` were
   * already abstract for the test doubles, so this is a binding choice rather
   * than a rewrite — and it is the first thing to actually exercise that
   * abstraction, which until now was an untested claim.
   */
  LLM_PROVIDER: z.enum(['anthropic', 'gemini']).default('gemini'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /** Model used for calendar intent classification and extraction. */
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),

  /** From Google AI Studio (aistudio.google.com/apikey). */
  GEMINI_API_KEY: z.string().min(1).optional(),

  /**
   * Note this is an alias, not a pinned version, which is not the usual
   * preference — a model can change underneath an alias.
   *
   * Pinned names (`gemini-2.5-flash`, `gemini-2.5-flash-lite`) return 404 for
   * keys created after those models were retired from new signups, so an alias
   * is the only option that works on a fresh key. `eval:router` is how a
   * change under the alias gets caught.
   *
   * Defaults to flash-LITE rather than flash because of the free tier, and the
   * difference is not marginal: `gemini-flash-latest` currently resolves to a
   * model allowing **20 requests per day** for free, which one testing session
   * exhausts. Flash-lite's allowance is far higher. Set this to
   * `gemini-flash-latest` when routing quality matters more than volume and
   * billing is enabled.
   */
  GEMINI_MODEL: z.string().min(1).default('gemini-flash-lite-latest'),

  /** How long a pending delete/reschedule waits for confirmation, in seconds. */
  PENDING_ACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** Public base URL used to build the OAuth link sent over Telegram. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  // --- Phase 3: RAG agent ---------------------------------------------------
  //
  // No API key here: embeddings run locally (all-MiniLM-L6-v2 via
  // transformers.js), so nothing about a stored document leaves this machine.
  // The RAG agent does still use ANTHROPIC_API_KEY above for classification,
  // summarisation, and grounded answering.

  /** Chunks retrieved per question before the relevance filter. */
  RAG_TOP_K: z.coerce.number().int().positive().default(5),

  /**
   * Minimum cosine similarity for a chunk to be considered relevant.
   *
   * Vector search always returns its nearest neighbours, even when the nearest
   * thing is unrelated — so without a floor an almost-empty knowledge base
   * hands the model irrelevant context that reads as authoritative. 0.3 is
   * tuned for all-MiniLM-L6-v2, whose scores run lower than larger models';
   * revisit it if the embedding model changes.
   */
  RAG_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),

  // --- Phase 4a: intent router ---------------------------------------------

  /**
   * How long an unanswered routing question survives, in seconds.
   *
   * Shorter than the calendar confirmation TTL: "did you mean your calendar or
   * your notes?" stops making sense once the user has moved on, whereas a
   * pending delete is still meaningful minutes later.
   */
  CLARIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(180),

  /** Timezone used for relative-time extraction when a user has none stored. */
  DEFAULT_TIMEZONE: z.string().min(1).default('UTC'),

  /**
   * Forces one timezone for every user, ignoring what Google reports.
   *
   * A deliberate blunt instrument, and not the long-term answer. Per-user zones
   * come from the calendar's own setting, which turned out to be unreliable: a
   * real account reported no timezone at all, the client substituted UTC, and
   * every "11:30am" for that user landed at 17:00 on their own phone. Until
   * per-user timezones are handled properly — read from a real source, with a
   * way for the user to correct it — pinning a single known-correct zone is
   * more honest than deriving a wrong one.
   *
   * Leave unset for per-user behaviour. Setting it in a multi-timezone
   * deployment WILL put events at the wrong hour for anyone outside it.
   */
  TIMEZONE_OVERRIDE: z
    .string()
    .optional()
    // An empty value means "not set". Blanking a line is how people disable a
    // variable, and it is the only way .env.test can shadow one that .env sets
    // — Nest loads both, and an unset key silently inherits the developer's.
    .transform((value) => (value?.trim() ? value.trim() : undefined)),
});

export type Env = z.infer<typeof envSchema>;

/**
 * The credentials the calendar agent cannot operate without.
 *
 * All-or-nothing on purpose: a half-configured integration (a Google client but
 * no encryption key, say) fails deep inside a request with a confusing error.
 * Reporting it as unconfigured up front is both easier to diagnose and safer.
 */
/**
 * Calendar credentials that do not depend on which LLM provider is active.
 */
export const CALENDAR_BASE_VARS = [
  'TOKEN_ENCRYPTION_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'OAUTH_STATE_SECRET',
] as const satisfies readonly (keyof Env)[];

/**
 * Everything the calendar agent needs, for the provider actually in use.
 *
 * Provider-dependent because the agent needs *an* LLM, not Anthropic
 * specifically — reporting `ANTHROPIC_API_KEY` missing on a Gemini deployment
 * would be exactly the misleading diagnostic the placeholder work set out to
 * remove.
 */
export function calendarRequiredVars(
  provider: Env['LLM_PROVIDER'],
): readonly string[] {
  return [...CALENDAR_BASE_VARS, PROVIDER_KEY_VAR[provider]];
}

/**
 * The credentials any LLM-backed path needs — which since Phase 4a means the
 * router, and therefore *every actionable message*, not just calendar ones.
 *
 * Separate from CALENDAR_REQUIRED_VARS because the failure modes differ: a
 * missing Google client degrades one agent, while a missing Anthropic key
 * degrades routing itself and so has to be reported and handled on its own.
 */
export const LLM_REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
] as const satisfies readonly (keyof Env)[];

/** The key each provider needs. Only the active provider's key is required. */
export const PROVIDER_KEY_VAR = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
} as const satisfies Record<Env['LLM_PROVIDER'], keyof Env>;

/**
 * Values that are present but obviously not real credentials.
 *
 * These are the literal strings shipped in `.env.example`, plus the generic
 * shapes people substitute by hand. Detecting them matters because the setup
 * path the README recommends — `cp .env.example .env` — produces an
 * environment where every credential is non-empty, so a presence check alone
 * reports a fully configured system that fails on the first real request. The
 * whole point of reporting configuration state is to catch exactly that.
 *
 * Deliberately conservative: it matches placeholder *shapes*, never a specific
 * vendor's key format. Anthropic and Google are free to change what a real key
 * looks like, and a check that rejects a valid credential is far worse than one
 * that misses a fake.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^your[-_]/i, // your-client-id…, your-client-secret
  /your[-_]key[-_]here/i, // sk-ant-your-key-here
  /change[-_]?me/i, // change-me-to-a-long-random-string
  /^placeholder/i, // placeholder-bot-token
  /^replace[-_]/i,
  /^<.+>$/, // <your-token>
  /^(xxx+|\.\.\.)$/i,
];

/**
 * A hex secret of one repeated character — `0000…0000` in `.env.example`.
 *
 * Called out separately because it passes every format check the schema
 * applies: it is exactly 64 hex characters and produces a working AES key. A
 * deployment encrypting tokens under a publicly known all-zero key is strictly
 * worse than one that knows it is unconfigured, because it looks safe.
 */
const REPEATED_CHAR_SECRET = /^(.)\1{15,}$/;

/** Whether a supplied value is a placeholder rather than a real credential. */
export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false; // absent, not placeholder — a different report
  return (
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
    REPEATED_CHAR_SECRET.test(trimmed)
  );
}

export interface ConfigAudit {
  /** Variables with no value at all. */
  missing: string[];
  /** Variables set to something that is plainly not a real credential. */
  placeholder: string[];
}

/** Audits a set of required variables for absence and for placeholder values. */
export function auditConfig(
  env: Partial<Record<string, string | undefined>>,
  keys: readonly string[],
): ConfigAudit {
  const missing: string[] = [];
  const placeholder: string[] = [];

  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === '') {
      missing.push(key);
    } else if (isPlaceholderValue(value)) {
      placeholder.push(key);
    }
  }

  return { missing, placeholder };
}

type CalendarEnv = Partial<Record<string, string | undefined>>;

/** Which calendar credentials are absent. Empty means none are absent. */
export function missingCalendarConfig(
  env: CalendarEnv,
  provider: Env['LLM_PROVIDER'] = 'anthropic',
): string[] {
  return auditConfig(env, calendarRequiredVars(provider)).missing;
}

/** Which calendar credentials are still set to a placeholder value. */
export function placeholderCalendarConfig(
  env: CalendarEnv,
  provider: Env['LLM_PROVIDER'] = 'anthropic',
): string[] {
  return auditConfig(env, calendarRequiredVars(provider)).placeholder;
}

export function isCalendarConfigured(
  env: CalendarEnv,
  provider: Env['LLM_PROVIDER'] = 'anthropic',
): boolean {
  const { missing, placeholder } = auditConfig(
    env,
    calendarRequiredVars(provider),
  );
  return missing.length === 0 && placeholder.length === 0;
}

/**
 * Nest's ConfigModule `validate` hook. Throwing here aborts bootstrap.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
