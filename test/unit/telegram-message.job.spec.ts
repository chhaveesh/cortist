import {
  TELEGRAM_MESSAGE_JOB,
  telegramMessageJobId,
  telegramMessageJobSchema,
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
