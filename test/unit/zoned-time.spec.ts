import {
  formatZonedNow,
  zonedOffset,
  zonedParts,
} from '../../src/common/zoned-time';

/**
 * The bug these prevent, seen against a real calendar on 2026-07-23.
 *
 * The router sent the model `2026-07-22T20:43Z` plus "User timezone:
 * Asia/Kolkata" and left it to convert. At 02:13 IST `gemini-flash-lite` read
 * the UTC date as the local one, so "today" was a day in the past and
 * "add a dentist appointment today at 10am" landed on Wed 22 Jul instead of
 * Thu 23 Jul. A stronger model got it right, which made the bug latent until a
 * model change exposed it — the worst kind.
 */
describe('zoned time for the classifier prompt', () => {
  it('gives the local date, not the UTC one, across the offset boundary', () => {
    // 20:43 UTC is already the NEXT day at +05:30.
    const now = new Date('2026-07-22T20:43:16Z');

    const formatted = formatZonedNow(now, 'Asia/Kolkata');

    expect(formatted).toBe('2026-07-23T02:13:16+05:30 (Thursday)');
    expect(formatted).not.toContain('2026-07-22');
  });

  it('gives the local date behind UTC too', () => {
    // 02:00 UTC is still the previous day in New York.
    expect(
      formatZonedNow(new Date('2026-07-23T02:00:00Z'), 'America/New_York'),
    ).toBe('2026-07-22T22:00:00-04:00 (Wednesday)');
  });

  it('names the weekday, so "next Tuesday" needs no derivation', () => {
    expect(
      formatZonedNow(new Date('2026-07-20T09:00:00Z'), 'Europe/London'),
    ).toContain('(Monday)');
  });

  it('tracks daylight saving rather than assuming a fixed offset', () => {
    const summer = new Date('2026-07-20T12:00:00Z');
    const winter = new Date('2026-01-20T12:00:00Z');

    expect(zonedOffset(summer, 'Europe/London')).toBe('+01:00');
    expect(zonedOffset(winter, 'Europe/London')).toBe('+00:00');
  });

  it('renders midnight as 00, not 24', () => {
    const parts = zonedParts(new Date('2026-07-23T00:00:00Z'), 'UTC');
    expect(parts.hour).toBe('00');
    expect(parts.day).toBe('23');
  });

  it('falls back to ISO on an unusable zone rather than throwing', () => {
    // A bad stored timezone must not take classification down with it.
    expect(formatZonedNow(new Date('2026-07-23T02:00:00Z'), 'Not/AZone')).toBe(
      '2026-07-23T02:00:00.000Z',
    );
  });
});
