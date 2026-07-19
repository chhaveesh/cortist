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

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),
    chat: telegramChatSchema,
    from: telegramUserSchema.optional(),
    text: z.string().optional(),
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
export interface ActionableMessage {
  telegramUserId: bigint;
  chatId: bigint;
  messageId: number;
  text: string;
}

export function extractActionableMessage(
  update: TelegramUpdate,
): ActionableMessage | null {
  const message = update.message ?? update.edited_message;

  if (!message) return null;
  if (!message.from) return null;
  if (message.from.is_bot) return null;
  if (typeof message.text !== 'string' || message.text.length === 0)
    return null;

  return {
    telegramUserId: BigInt(message.from.id),
    chatId: BigInt(message.chat.id),
    messageId: message.message_id,
    text: message.text,
  };
}
