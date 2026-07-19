import {
  extractActionableMessage,
  telegramUpdateSchema,
} from '../../src/telegram/telegram.schema';
import {
  MALFORMED_UPDATES,
  buildBotAuthoredUpdate,
  buildNonTextUpdate,
  buildTelegramUpdate,
} from '../fixtures/telegram-update.fixture';

describe('telegramUpdateSchema', () => {
  it('accepts a realistic Telegram update', () => {
    const result = telegramUpdateSchema.safeParse(buildTelegramUpdate());
    expect(result.success).toBe(true);
  });

  it('preserves fields it does not model, so new Telegram fields survive', () => {
    const update = buildTelegramUpdate();
    (update.message as Record<string, unknown>).some_future_field = { a: 1 };

    const result = telegramUpdateSchema.parse(update);
    expect(
      (result.message as Record<string, unknown>).some_future_field,
    ).toEqual({
      a: 1,
    });
  });

  it.each(
    MALFORMED_UPDATES.filter(
      (c) => typeof c.body === 'object' && c.body !== null,
    ),
  )('rejects $name', ({ body }) => {
    expect(telegramUpdateSchema.safeParse(body).success).toBe(false);
  });

  it('accepts an update carrying no message (e.g. a poll answer)', () => {
    // Schema-valid; the actionable-message extractor is what filters it out.
    expect(
      telegramUpdateSchema.safeParse({ update_id: 1, poll_answer: {} }).success,
    ).toBe(true);
  });
});

describe('extractActionableMessage', () => {
  it('extracts ids as BigInt and the text verbatim', () => {
    const update = telegramUpdateSchema.parse(
      buildTelegramUpdate({
        telegramUserId: 42,
        chatId: 99,
        messageId: 7,
        text: 'hello',
      }),
    );

    expect(extractActionableMessage(update)).toEqual({
      telegramUserId: 42n,
      chatId: 99n,
      messageId: 7,
      text: 'hello',
    });
  });

  it('reads an edited message when no fresh message is present', () => {
    const original = buildTelegramUpdate({ messageId: 5, text: 'edited text' });
    const update = telegramUpdateSchema.parse({
      update_id: original.update_id,
      edited_message: original.message,
    });

    expect(extractActionableMessage(update)?.text).toBe('edited text');
  });

  it('returns null for an update with no message at all', () => {
    const update = telegramUpdateSchema.parse({ update_id: 1 });
    expect(extractActionableMessage(update)).toBeNull();
  });

  it('returns null for a bot-authored message', () => {
    const update = telegramUpdateSchema.parse(buildBotAuthoredUpdate());
    expect(extractActionableMessage(update)).toBeNull();
  });

  it('returns null for a message with no text', () => {
    const update = telegramUpdateSchema.parse(buildNonTextUpdate());
    expect(extractActionableMessage(update)).toBeNull();
  });

  it('returns null for an anonymous message with no sender', () => {
    const update = telegramUpdateSchema.parse({
      update_id: 1,
      message: { message_id: 1, date: 1, chat: { id: 1 }, text: 'hi' },
    });
    expect(extractActionableMessage(update)).toBeNull();
  });

  it('returns null for empty text', () => {
    const update = telegramUpdateSchema.parse(
      buildTelegramUpdate({ text: '' }),
    );
    expect(extractActionableMessage(update)).toBeNull();
  });
});
