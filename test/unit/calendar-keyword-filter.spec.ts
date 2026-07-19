import { looksCalendarRelated } from '../../src/agents/calendar/intent/calendar-keyword-filter';

describe('looksCalendarRelated', () => {
  it.each([
    'Book me a dentist appointment on Friday',
    'move my 3pm call to tomorrow',
    'cancel the standup',
    'what does my calendar look like next week?',
    'am I free on Thursday?',
    'schedule a sync with Priya',
    'set up a meeting at 14:00',
    'lunch with Sam tomorrow',
    'push the interview to next Monday',
    'block off 2 hours Wednesday morning',
    'delete the 9am',
    'reschedule my coffee with Alex',
  ])('lets a calendar message through: %s', (text) => {
    expect(looksCalendarRelated(text)).toBe(true);
  });

  it.each([
    'what is the capital of France?',
    'summarise this article for me',
    'thanks!',
    'can you write a python script to parse csv files',
    'who won the game last night',
  ])('filters out an unrelated message: %s', (text) => {
    expect(looksCalendarRelated(text)).toBe(false);
  });

  /**
   * The cost of the pre-filter, made explicit rather than left to be discovered
   * in production.
   *
   * These are genuine calendar requests that contain none of the keywords, so
   * the agent never sees them and the user gets no reply. This test is not
   * asserting the behaviour is good — it is pinning the known blind spot so it
   * is visible in review, and so it fails loudly if the general router later
   * changes the contract. See DECISIONS.md §26.
   */
  it('documents the known false negatives (messages it wrongly drops)', () => {
    const missed = [
      'put something in for the 5th',
      'I need to see the orthodontist',
      'shift it back an hour',
    ];

    for (const text of missed) {
      expect(looksCalendarRelated(text)).toBe(false);
    }
  });

  /**
   * Regression: the month pattern was once `(jan|feb|mar|…|may|…)[a-z]*`, a
   * prefix match that also fired on ordinary English words. "maybe" matching
   * "may" mattered in practice — a false positive here used to be enough to
   * discard a pending delete confirmation.
   */
  it.each([
    'maybe',
    'hmm maybe',
    'let me decide later',
    'they are separate issues',
    'the market is closed',
    'walking through the jungle',
    'I have marched on',
  ])('does not fire on a word that merely starts like a month: %s', (text) => {
    expect(looksCalendarRelated(text)).toBe(false);
  });

  it.each([
    'the 3rd of March',
    'sometime in Feb',
    'due December 12',
    'shift it to may',
  ])('still recognises genuine month references: %s', (text) => {
    expect(looksCalendarRelated(text)).toBe(true);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(looksCalendarRelated('')).toBe(false);
    expect(looksCalendarRelated('   ')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(looksCalendarRelated('CANCEL THE MEETING')).toBe(true);
  });
});
