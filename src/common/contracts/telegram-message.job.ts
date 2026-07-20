import { z } from 'zod';

/**
 * ---------------------------------------------------------------------------
 * The queue contract.
 * ---------------------------------------------------------------------------
 *
 * This file is the seam between the ingestion layer (Phase 1) and every agent
 * that consumes messages (Phase 2+). Treat it as a published API:
 *
 *  - Never change the meaning of an existing field in a published version.
 *  - To evolve, add a new version and widen the union below. Consumers switch
 *    on `version`, and jobs already sitting in Redis keep deserializing
 *    correctly during a rolling deploy.
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

const baseFields = {
  jobType: z.literal(TELEGRAM_MESSAGE_JOB),

  /** Internal Cortist user id (users.id). */
  tenantId: z.string().uuid(),

  telegramUserId: bigIntString,
  chatId: bigIntString,

  /** Telegram's per-chat message counter; unique within a chat. */
  messageId: z.number().int(),

  text: z.string(),

  /** ISO-8601 UTC timestamp stamped by the gateway on receipt. */
  receivedAt: z.string().datetime(),
};

export const telegramMessageJobV1Schema = z.object({
  ...baseFields,
  version: z.literal(1),
});

export type TelegramMessageJobV1 = z.infer<typeof telegramMessageJobV1Schema>;

/**
 * A file the user uploaded or forwarded.
 *
 * Only the Telegram file *reference* travels on the queue — never the bytes.
 * A 20MB PDF has no business in a Redis job payload; the worker fetches it
 * from Telegram when it is ready to process it.
 */
export const telegramAttachmentSchema = z.object({
  /** Telegram's opaque file handle, resolved via getFile at download time. */
  fileId: z.string().min(1),
  /** Original filename, when Telegram supplies one. */
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  /** Size in bytes as reported by Telegram, for an early size check. */
  fileSize: z.number().int().nonnegative().optional(),
});

export type TelegramAttachment = z.infer<typeof telegramAttachmentSchema>;

/**
 * v2 — adds document attachments.
 *
 * Introduced for the RAG agent (Phase 3). Until then the gateway dropped
 * document uploads entirely: `extractActionableMessage` required a non-empty
 * `text`, and a Telegram document message carries `document` plus an optional
 * `caption` and no `text` at all. Those uploads were acknowledged with a 200
 * and silently discarded.
 *
 * Note `text` stays required and is the caption for an attachment (empty string
 * when there is none), so a v2 consumer can read `text` without a null check
 * exactly as a v1 consumer does.
 */
export const telegramMessageJobV2Schema = z.object({
  ...baseFields,
  version: z.literal(2),
  attachment: telegramAttachmentSchema.optional(),
});

export type TelegramMessageJobV2 = z.infer<typeof telegramMessageJobV2Schema>;

/**
 * The discriminated union consumers should accept.
 *
 * v1 remains here on purpose. Removing it the moment v2 shipped would break
 * every job already enqueued — which is the exact failure the versioning exists
 * to prevent.
 */
export const telegramMessageJobSchema = z.discriminatedUnion('version', [
  telegramMessageJobV1Schema,
  telegramMessageJobV2Schema,
]);

export type TelegramMessageJob = z.infer<typeof telegramMessageJobSchema>;

/** The version the gateway emits today. */
export const CURRENT_TELEGRAM_MESSAGE_JOB_VERSION = 2 as const;

/**
 * Reads the attachment from any contract version.
 *
 * Consumers should use this rather than `job.attachment`, so a v1 job — which
 * has no such field — is handled without a version check at every call site.
 */
export function attachmentOf(
  job: TelegramMessageJob,
): TelegramAttachment | undefined {
  return job.version === 2 ? job.attachment : undefined;
}

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
