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

  /**
   * 32-byte AES-256-GCM key, hex-encoded (64 hex chars). Encrypts OAuth tokens
   * at rest. Rotating it makes every stored token undecryptable, forcing users
   * to reconnect — treat it as durable secret material.
   */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /**
   * Must match a redirect URI registered in the Google Cloud console exactly,
   * including scheme, port, and path.
   */
  GOOGLE_REDIRECT_URI: z.string().url(),

  /** Signs the OAuth `state` parameter so callbacks cannot be forged. */
  OAUTH_STATE_SECRET: z.string().min(16),

  /** How long a generated OAuth link stays valid, in seconds. */
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  ANTHROPIC_API_KEY: z.string().min(1),

  /** Model used for calendar intent classification and extraction. */
  ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),

  /** How long a pending delete/reschedule waits for confirmation, in seconds. */
  PENDING_ACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** Public base URL used to build the OAuth link sent over Telegram. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

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
