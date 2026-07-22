/**
 * Interpreting a reply to "how long should it be?".
 *
 * Deterministic rather than an LLM call, for the same reasons as
 * `confirmation-reply.ts`: the ways people express a duration are few and
 * closed, the user is waiting, and a model that reads "half an hour" as three
 * hours puts a wrong commitment in a real calendar. Anything not clearly a
 * duration returns null and we re-ask instead of guessing.
 *
 * The offered buttons (30 minutes / 1 hour / 2 hours) are the common cases; the
 * parser deliberately accepts far more than the buttons offer, because a reply
 * keyboard does not stop anyone typing "45 mins".
 */

/** Upper bound on a single event, to catch a misread rather than book a week. */
const MAX_MINUTES = 24 * 60;

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  half: 0.5,
};

/**
 * Minutes, or null when the reply is not a duration.
 *
 * Null is the important case: it means re-ask, never assume a default.
 */
export function interpretDuration(text: string): number | null {
  const normalised = text
    .trim()
    .toLowerCase()
    .replace(/[.,!]+$/, '');

  if (normalised === '') return null;

  // "half an hour" / "half hour" — common enough to be worth naming, and it
  // would otherwise parse as the number 0.5 followed by a stray "an".
  if (/^(a\s+)?half(\s+an?)?\s+hour$/.test(normalised)) return 30;
  if (/^(an?\s+)?hour(\s+and\s+a\s+half)$/.test(normalised)) return 90;

  // "1h30", "1h 30m"
  // The trailing unit is optional: "1h30" is as common as "1h 30m".
  const compound =
    /^(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*(?:m(?:in(?:ute)?s?)?)?$/.exec(
      normalised,
    );
  if (compound) {
    return bounded(Number(compound[1]) * 60 + Number(compound[2]));
  }

  const match =
    /^(?:for\s+)?([\d.]+|[a-z]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(
      normalised,
    );
  if (!match) return null;

  const [, rawAmount, unit] = match;
  const amount = /^[\d.]+$/.test(rawAmount)
    ? Number.parseFloat(rawAmount)
    : WORD_NUMBERS[rawAmount];

  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const minutes = unit.startsWith('h') ? amount * 60 : amount;
  return bounded(minutes);
}

function bounded(minutes: number): number | null {
  const rounded = Math.round(minutes);
  if (rounded <= 0 || rounded > MAX_MINUTES) return null;
  return rounded;
}

/** The quick-reply options offered alongside the question. */
export const DURATION_OPTIONS = ['30 minutes', '1 hour', '2 hours'] as const;
