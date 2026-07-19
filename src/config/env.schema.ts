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
