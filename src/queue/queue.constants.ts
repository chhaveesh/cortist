/**
 * Queue names. Kept in one place so gateway and worker cannot drift apart —
 * a typo in either would silently produce jobs nobody consumes.
 */
export const QUEUES = {
  /** Inbound Telegram messages awaiting agent routing. */
  TELEGRAM_MESSAGES: 'telegram-messages',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Retry policy, applied to every job.
 *
 * Total attempts including the first. With exponential backoff from
 * JOB_BACKOFF_BASE_MS, a job is retried at ~2s and ~4s before being moved to
 * the failed set.
 */
export const JOB_ATTEMPTS = 3;

/** Base delay for exponential backoff: delay * 2^(attempt - 1). */
export const JOB_BACKOFF_BASE_MS = 2_000;
