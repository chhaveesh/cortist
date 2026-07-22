import {
  DURATION_OPTIONS,
  interpretDuration,
} from '../../src/agents/calendar/pending-action/duration-reply';

/**
 * Reading a reply to "how long should it be?".
 *
 * Deterministic for the same reasons as the yes/no parser: the phrasings are
 * few and closed, the user is waiting, and misreading "half an hour" as three
 * hours books a real slot wrongly. Null means re-ask — never assume a default,
 * because assuming a default is the behaviour this whole feature replaced.
 */
describe('interpretDuration', () => {
  describe('the offered buttons', () => {
    // Whatever else changes, a tap must always parse.
    it.each(DURATION_OPTIONS)('parses the "%s" button exactly', (option) => {
      expect(interpretDuration(option)).not.toBeNull();
    });

    it('maps each button to the duration it names', () => {
      expect(interpretDuration('30 minutes')).toBe(30);
      expect(interpretDuration('1 hour')).toBe(60);
      expect(interpretDuration('2 hours')).toBe(120);
    });
  });

  /**
   * A reply keyboard does not stop anyone typing, so the parser deliberately
   * accepts much more than the three buttons offer.
   */
  describe('typed answers', () => {
    it.each([
      ['45 mins', 45],
      ['45 minutes', 45],
      ['45m', 45],
      ['90 minutes', 90],
      ['2h', 120],
      ['3 hrs', 180],
      ['1.5 hours', 90],
      ['half an hour', 30],
      ['half hour', 30],
      ['an hour', 60],
      ['an hour and a half', 90],
      ['two hours', 120],
      ['1h30', 90],
      ['1h 30m', 90],
      ['for 20 minutes', 20],
      ['  1 Hour  ', 60],
      ['30 minutes.', 30],
    ])('reads %s as %i minutes', (text, minutes) => {
      expect(interpretDuration(text)).toBe(minutes);
    });
  });

  /**
   * The important direction. Anything not clearly a duration must return null
   * so the agent re-asks — guessing here books the wrong slot silently.
   */
  describe('non-answers', () => {
    it.each([
      [''],
      ['   '],
      ['yes'],
      ['ok'],
      ['whenever'],
      ['a while'],
      ['not sure'],
      ['tomorrow'],
      ['cancel my dentist appointment'],
      ['0 minutes'],
      ['-30 minutes'],
      ['5'], // a bare number: five what?
      ['hours'],
    ])('refuses to guess at %s', (text) => {
      expect(interpretDuration(text)).toBeNull();
    });

    it('rejects an implausible length rather than booking a week', () => {
      // More likely a misread than a real 100-hour meeting.
      expect(interpretDuration('100 hours')).toBeNull();
      expect(interpretDuration('5000 minutes')).toBeNull();
    });

    it('accepts a full day, which is a real thing people book', () => {
      expect(interpretDuration('24 hours')).toBe(1440);
    });
  });
});
