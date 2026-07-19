/**
 * Fixtures mirroring Telegram's real Bot API `Update` payloads.
 *
 * Field names, types, and nesting match what Telegram actually POSTs to a
 * webhook (see https://core.telegram.org/bots/api#update). This is what lets
 * the suite exercise the true request shape without a public URL, a tunnel, or
 * a live bot token.
 */

export interface TelegramUpdateFixtureOptions {
  updateId?: number;
  messageId?: number;
  telegramUserId?: number;
  chatId?: number;
  text?: string;
  /** Unix seconds. */
  date?: number;
}

const DEFAULTS = {
  updateId: 900_100_200,
  messageId: 4242,
  telegramUserId: 123_456_789,
  chatId: 123_456_789,
  text: 'What does my calendar look like tomorrow?',
  date: 1_768_000_000,
} as const;

/** A valid private-chat text message — the happy path. */
export function buildTelegramUpdate(
  options: TelegramUpdateFixtureOptions = {},
): Record<string, unknown> {
  const o = { ...DEFAULTS, ...options };

  return {
    update_id: o.updateId,
    message: {
      message_id: o.messageId,
      from: {
        id: o.telegramUserId,
        is_bot: false,
        first_name: 'Ada',
        username: 'ada_l',
        language_code: 'en',
      },
      chat: {
        id: o.chatId,
        first_name: 'Ada',
        username: 'ada_l',
        type: 'private',
      },
      date: o.date,
      text: o.text,
    },
  };
}

/** An update from another bot — valid schema, but must not be enqueued. */
export function buildBotAuthoredUpdate(): Record<string, unknown> {
  const update = buildTelegramUpdate({ updateId: 900_100_299 });
  const message = update.message as Record<string, unknown>;
  message.from = { ...(message.from as object), is_bot: true };
  return update;
}

/** A sticker message: no `text`, so there is nothing to route. */
export function buildNonTextUpdate(): Record<string, unknown> {
  const update = buildTelegramUpdate({ updateId: 900_100_298 });
  const message = update.message as Record<string, unknown>;
  delete message.text;
  message.sticker = { file_id: 'CAACAgIAAxkBAAI', width: 512, height: 512 };
  return update;
}

/** Payloads that must be rejected with a 400. */
export const MALFORMED_UPDATES: Array<{ name: string; body: unknown }> = [
  { name: 'empty object', body: {} },
  { name: 'missing update_id', body: { message: { message_id: 1 } } },
  {
    name: 'update_id of the wrong type',
    body: { update_id: 'not-a-number', message: null },
  },
  {
    name: 'message missing message_id',
    body: {
      update_id: 1,
      message: { date: 1, chat: { id: 1 }, text: 'hi' },
    },
  },
  {
    name: 'message.chat missing id',
    body: {
      update_id: 2,
      message: { message_id: 1, date: 1, chat: {}, text: 'hi' },
    },
  },
  {
    name: 'text of the wrong type',
    body: {
      update_id: 3,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 1 },
        from: { id: 1 },
        text: 12345,
      },
    },
  },
  { name: 'a bare array', body: [1, 2, 3] },
  { name: 'a bare string', body: 'hello' },
];
