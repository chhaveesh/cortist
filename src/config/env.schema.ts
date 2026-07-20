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

  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /** Model used for calendar intent classification and extraction. */
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),

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
});

export type Env = z.infer<typeof envSchema>;

/**
 * The credentials the calendar agent cannot operate without.
 *
 * All-or-nothing on purpose: a half-configured integration (a Google client but
 * no encryption key, say) fails deep inside a request with a confusing error.
 * Reporting it as unconfigured up front is both easier to diagnose and safer.
 */
export const CALENDAR_REQUIRED_VARS = [
  'TOKEN_ENCRYPTION_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'OAUTH_STATE_SECRET',
  'ANTHROPIC_API_KEY',
] as const satisfies readonly (keyof Env)[];

/** Which calendar credentials are absent. Empty means fully configured. */
export function missingCalendarConfig(
  env: Pick<Env, (typeof CALENDAR_REQUIRED_VARS)[number]>,
): string[] {
  return CALENDAR_REQUIRED_VARS.filter((key) => {
    const value = env[key];
    return value === undefined || value === '';
  });
}

export function isCalendarConfigured(
  env: Pick<Env, (typeof CALENDAR_REQUIRED_VARS)[number]>,
): boolean {
  return missingCalendarConfig(env).length === 0;
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
