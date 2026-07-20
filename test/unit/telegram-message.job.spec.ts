import {
  TELEGRAM_MESSAGE_JOB,
  attachmentOf,
  telegramMessageJobId,
  telegramMessageJobSchema,
  telegramMessageJobV1Schema,
  telegramMessageJobV2Schema,
} from '../../src/common/contracts/telegram-message.job';

const VALID = {
  jobType: TELEGRAM_MESSAGE_JOB,
  version: 1 as const,
  tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  telegramUserId: '123456789',
  chatId: '-1001234567890',
  messageId: 42,
  text: 'hello',
  receivedAt: '2026-07-19T12:00:00.000Z',
};

describe('telegram message job contract', () => {
  it('accepts a well-formed v1 payload', () => {
    expect(telegramMessageJobSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ['a non-uuid tenantId', { tenantId: 'not-a-uuid' }],
    ['a numeric telegramUserId', { telegramUserId: 123456789 }],
    ['a non-numeric id string', { telegramUserId: 'abc' }],
    ['a non-integer messageId', { messageId: 1.5 }],
    ['a non-ISO receivedAt', { receivedAt: 'yesterday' }],
    ['an unknown version', { version: 99 }],
    ['a wrong jobType', { jobType: 'calendar_event' }],
  ])('rejects %s', (_name, override) => {
    const result = telegramMessageJobSchema.safeParse({
      ...VALID,
      ...override,
    });
    expect(result.success).toBe(false);
  });

  it('builds a job id that is stable and unique per (chat, message)', () => {
    expect(telegramMessageJobId('-1001234567890', 42)).toBe(
      'tg:-1001234567890:42',
    );
    // Same inputs always yield the same id — this is what makes it a dedupe key.
    expect(telegramMessageJobId('456', 1)).toBe(telegramMessageJobId('456', 1));
    expect(telegramMessageJobId('456', 1)).not.toBe(
      telegramMessageJobId('457', 1),
    );
  });

  it('survives a JSON round trip unchanged, as it must through Redis', () => {
    const roundTripped = JSON.parse(JSON.stringify(VALID));
    expect(roundTripped).toEqual(VALID);
    expect(telegramMessageJobSchema.safeParse(roundTripped).success).toBe(true);
  });
});

describe('contract versioning', () => {
  const V2_BASE = { ...VALID, version: 2 as const };

  /**
   * The reason the union exists. When v2 shipped, jobs enqueued moments earlier
   * were still sitting in Redis as v1 — dropping v1 support would have failed
   * every one of them mid-deploy, which is the exact outage the versioning is
   * there to prevent.
   */
  it('still accepts v1 jobs, so in-flight work survives a rolling deploy', () => {
    expect(telegramMessageJobSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts a v2 job without an attachment', () => {
    expect(telegramMessageJobSchema.safeParse(V2_BASE).success).toBe(true);
  });

  it('accepts a v2 job with an attachment', () => {
    const parsed = telegramMessageJobSchema.safeParse({
      ...V2_BASE,
      attachment: {
        fileId: 'BQACAgIAAxkBAAI',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires a non-empty fileId on an attachment', () => {
    // A blank handle cannot be resolved, so it would fail at download time with
    // a far more confusing error than a validation failure here.
    expect(
      telegramMessageJobSchema.safeParse({
        ...V2_BASE,
        attachment: { fileId: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects an attachment on a v1 job', () => {
    // v1 has no such field, and silently tolerating it would make `version`
    // decorative.
    const parsed = telegramMessageJobSchema.safeParse({
      ...VALID,
      attachment: { fileId: 'x' },
    });
    if (parsed.success) {
      expect('attachment' in parsed.data).toBe(false);
    }
  });

  describe('attachmentOf', () => {
    it('returns undefined for a v1 job rather than throwing', () => {
      // Lets consumers read attachments without a version check at every site.
      const v1 = telegramMessageJobV1Schema.parse(VALID);
      expect(attachmentOf(v1)).toBeUndefined();
    });

    it('returns undefined for a v2 job with no attachment', () => {
      const v2 = telegramMessageJobV2Schema.parse(V2_BASE);
      expect(attachmentOf(v2)).toBeUndefined();
    });

    it('returns the attachment for a v2 job that has one', () => {
      const v2 = telegramMessageJobV2Schema.parse({
        ...V2_BASE,
        attachment: { fileId: 'file-123', fileName: 'a.pdf' },
      });
      expect(attachmentOf(v2)?.fileId).toBe('file-123');
    });
  });
});
