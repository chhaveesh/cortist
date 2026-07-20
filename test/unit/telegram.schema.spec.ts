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

/**
 * Document uploads.
 *
 * Before Phase 3 these were dropped on the floor: `extractActionableMessage`
 * required a non-empty `text`, and a Telegram document message carries
 * `document` and `caption`, never `text`. The webhook answered 200 and the file
 * was silently discarded.
 */
describe('document messages', () => {
  const documentUpdate = (
    overrides: Record<string, unknown> = {},
    caption?: string,
  ) => ({
    update_id: 1,
    message: {
      message_id: 42,
      date: 1_768_000_000,
      chat: { id: 424242, type: 'private' },
      from: { id: 424242, is_bot: false, first_name: 'Ada' },
      document: {
        file_id: 'BQACAgIAAxkBAAI',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 51_200,
        ...overrides,
      },
      ...(caption === undefined ? {} : { caption }),
    },
  });

  it('accepts a document message as valid', () => {
    expect(telegramUpdateSchema.safeParse(documentUpdate()).success).toBe(true);
  });

  it('extracts the file reference from an upload with no caption', () => {
    const update = telegramUpdateSchema.parse(documentUpdate());
    const actionable = extractActionableMessage(update);

    expect(actionable).not.toBeNull();
    expect(actionable?.attachment).toEqual({
      fileId: 'BQACAgIAAxkBAAI',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 51_200,
    });
    // No caption means empty text, not null — downstream reads one field
    // regardless of how the message arrived.
    expect(actionable?.text).toBe('');
  });

  it("uses the caption as the message's text", () => {
    const update = telegramUpdateSchema.parse(
      documentUpdate({}, 'save this quarterly report'),
    );
    const actionable = extractActionableMessage(update);

    expect(actionable?.text).toBe('save this quarterly report');
    expect(actionable?.attachment?.fileName).toBe('report.pdf');
  });

  it('handles a document with no filename or mime type', () => {
    const update = telegramUpdateSchema.parse({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1,
        chat: { id: 1 },
        from: { id: 1, is_bot: false },
        document: { file_id: 'abc' },
      },
    });

    const actionable = extractActionableMessage(update);
    expect(actionable?.attachment).toEqual({
      fileId: 'abc',
      fileName: undefined,
      mimeType: undefined,
      fileSize: undefined,
    });
  });

  it('still ignores a message with neither text nor a document', () => {
    // A sticker or service message: acknowledged upstream, never enqueued.
    const update = telegramUpdateSchema.parse({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 1 },
        from: { id: 1, is_bot: false },
        sticker: { file_id: 'CAACAgIAAxkBAAI' },
      },
    });

    expect(extractActionableMessage(update)).toBeNull();
  });

  it('ignores a document sent by another bot', () => {
    const update = telegramUpdateSchema.parse(
      (() => {
        const base = documentUpdate();
        (base.message.from as Record<string, unknown>).is_bot = true;
        return base;
      })(),
    );

    expect(extractActionableMessage(update)).toBeNull();
  });
});
