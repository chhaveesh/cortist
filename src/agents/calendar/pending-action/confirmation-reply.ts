/**
 * Interpreting a reply to a confirmation prompt.
 *
 * Deliberately deterministic rather than an LLM call: the set of ways people
 * say yes or no is small and closed, the latency budget matters (the user is
 * waiting on a destructive action), and a model that hallucinates "affirmative"
 * would delete a real calendar event. Anything not clearly yes or no is
 * `unclear`, and we re-ask rather than assume.
 */
export type ConfirmationReply = 'affirmative' | 'negative' | 'unclear';

const AFFIRMATIVE = new Set([
  'y',
  'ye',
  'yes',
  'yes please',
  'yep',
  'yeah',
  'yup',
  'ya',
  'sure',
  'ok',
  'okay',
  'k',
  'confirm',
  'confirmed',
  'do it',
  'go ahead',
  'go for it',
  'please do',
  'affirmative',
  'correct',
  'right',
  'proceed',
  'delete it',
  'cancel it',
  'move it',
  '👍',
  '✅',
]);

const NEGATIVE = new Set([
  'n',
  'no',
  'nope',
  'nah',
  'cancel',
  'stop',
  'abort',
  'nevermind',
  'never mind',
  'no thanks',
  'no thank you',
  'dont',
  "don't",
  'do not',
  'leave it',
  'keep it',
  'negative',
  'wait',
  '👎',
  '❌',
]);

/**
 * Note the ordering: negatives are checked first. "no, cancel it" contains an
 * affirmative phrase ("cancel it") but is plainly a refusal, and on a
 * destructive action the safe misreading is to decline.
 */
export function interpretConfirmation(text: string): ConfirmationReply {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .replace(/\s+/g, ' ');

  if (normalized.length === 0) return 'unclear';

  if (NEGATIVE.has(normalized)) return 'negative';
  if (AFFIRMATIVE.has(normalized)) return 'affirmative';

  // Only accept a leading yes/no on longer replies ("yes, go ahead"), so a
  // sentence that merely contains "no" somewhere is not read as a refusal.
  //
  // Trailing punctuation is stripped from the word itself — "no, cancel it"
  // yields "no," otherwise, which matches nothing and would fall through to
  // `unclear` on what is plainly a refusal. The apostrophe is kept so "don't"
  // still matches.
  const firstWord = normalized.split(' ')[0].replace(/[^\p{L}\p{N}']/gu, '');
  if (NEGATIVE.has(firstWord)) return 'negative';
  if (AFFIRMATIVE.has(firstWord)) return 'affirmative';

  return 'unclear';
}
