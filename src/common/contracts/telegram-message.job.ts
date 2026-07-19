import { z } from 'zod';

/**
 * ---------------------------------------------------------------------------
 * The queue contract.
 * ---------------------------------------------------------------------------
 *
 * This file is the seam between the ingestion layer (Phase 1) and every agent
 * that will consume messages later (Phase 2+). Treat it as a published API:
 *
 *  - Never change the meaning of an existing field in v1.
 *  - To evolve, add `TelegramMessageJobV2` and widen the union below. Consumers
 *    then switch on `version`, and old jobs already sitting in Redis keep
 *    deserializing correctly during a rolling deploy.
 *
 * Encoding notes:
 *  - Telegram user and chat ids are 64-bit. JSON has no integer type wide
 *    enough to hold them safely, so they travel as decimal strings.
 *  - `tenantId` is Cortist's internal user id, not the Telegram id. Downstream
 *    agents should key all per-user state off this value.
 */

export const TELEGRAM_MESSAGE_JOB = 'telegram_message' as const;

/** Decimal string holding a 64-bit Telegram identifier. */
const bigIntString = z
  .string()
  .regex(/^-?\d+$/, 'must be a decimal integer string');

export const telegramMessageJobV1Schema = z.object({
  jobType: z.literal(TELEGRAM_MESSAGE_JOB),
  version: z.literal(1),

  /** Internal Cortist user id (users.id). */
  tenantId: z.string().uuid(),

  telegramUserId: bigIntString,
  chatId: bigIntString,

  /** Telegram's per-chat message counter; unique within a chat. */
  messageId: z.number().int(),

  text: z.string(),

  /** ISO-8601 UTC timestamp stamped by the gateway on receipt. */
  receivedAt: z.string().datetime(),
});

export type TelegramMessageJobV1 = z.infer<typeof telegramMessageJobV1Schema>;

/**
 * The discriminated union consumers should accept. Currently one member; new
 * versions get appended here rather than replacing v1.
 */
export const telegramMessageJobSchema = z.discriminatedUnion('version', [
  telegramMessageJobV1Schema,
]);

export type TelegramMessageJob = z.infer<typeof telegramMessageJobSchema>;

/** The current version emitted by the gateway. */
export const CURRENT_TELEGRAM_MESSAGE_JOB_VERSION = 1 as const;

/**
 * Stable, deterministic job id derived from the natural key of a Telegram
 * message. BullMQ refuses to enqueue a second job with the same id while the
 * first is still retained, giving a second line of defence behind the Redis
 * dedupe key.
 */
export function telegramMessageJobId(
  chatId: string,
  messageId: number,
): string {
  return `tg:${chatId}:${messageId}`;
}
