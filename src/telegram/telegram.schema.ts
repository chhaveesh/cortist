import { z } from 'zod';

/**
 * A deliberately narrow view of Telegram's `Update` object.
 *
 * Telegram sends ~30 optional update types and dozens of message fields. We
 * validate only what Phase 1 consumes and use `.passthrough()` so unknown
 * fields (and future Telegram additions) do not cause spurious rejections —
 * being strict here would mean rejecting perfectly valid traffic every time
 * Telegram ships a new field.
 */

export const telegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

export const telegramChatSchema = z
  .object({
    id: z.number().int(),
    type: z.string().optional(),
  })
  .passthrough();

/**
 * An uploaded or forwarded file. Telegram sends `document` for anything that
 * is not a photo/voice/video — PDFs and .txt files both arrive here.
 */
export const telegramDocumentSchema = z
  .object({
    file_id: z.string(),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),
    chat: telegramChatSchema,
    from: telegramUserSchema.optional(),
    text: z.string().optional(),
    /** Present instead of `text` when the user uploads a file. */
    document: telegramDocumentSchema.optional(),
    /** The message accompanying an upload — Telegram's `text` equivalent. */
    caption: z.string().optional(),
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/**
 * Narrowed shape the gateway can actually act on: a text message from an
 * identified human. Updates that do not reduce to this (channel posts,
 * stickers, service messages) are acknowledged but not enqueued.
 */
export interface ActionableAttachment {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface ActionableMessage {
  telegramUserId: bigint;
  chatId: bigint;
  messageId: number;
  /** Message text, or an upload's caption. Empty string when neither exists. */
  text: string;
  /** Present when the user uploaded a file. */
  attachment?: ActionableAttachment;
}

/**
 * Reduces an update to something an agent can act on.
 *
 * Two shapes qualify: a text message, or a file upload (with or without a
 * caption). Before Phase 3 this required non-empty `text`, which meant every
 * document upload was acknowledged and silently thrown away — a Telegram
 * document message carries `document` and `caption`, never `text`.
 */
export function extractActionableMessage(
  update: TelegramUpdate,
): ActionableMessage | null {
  const message = update.message ?? update.edited_message;

  if (!message) return null;
  if (!message.from) return null;
  if (message.from.is_bot) return null;

  const attachment = message.document
    ? {
        fileId: message.document.file_id,
        fileName: message.document.file_name,
        mimeType: message.document.mime_type,
        fileSize: message.document.file_size,
      }
    : undefined;

  // A caption stands in for text on an upload, so downstream code reads one
  // field regardless of how the message arrived.
  const text =
    typeof message.text === 'string' && message.text.length > 0
      ? message.text
      : (message.caption ?? '');

  // Neither words nor a file: nothing to act on (a sticker, a poll, a service
  // message). Acknowledged upstream, not enqueued.
  if (!attachment && text.length === 0) return null;

  return {
    telegramUserId: BigInt(message.from.id),
    chatId: BigInt(message.chat.id),
    messageId: message.message_id,
    text,
    ...(attachment ? { attachment } : {}),
  };
}
