/**
 * Cheap pre-filter that decides whether a message is worth an LLM call.
 *
 * TRADEOFF, stated plainly: this saves one small model call per non-calendar
 * message, at the cost of silently dropping any calendar request phrased
 * without a listed keyword. It is a recall/cost trade, and recall is the side
 * that fails invisibly — the user just gets no reply.
 *
 * Two mitigations keep that acceptable for this phase:
 *  - The list is deliberately generous, covering verbs, nouns, weekdays,
 *    months, and time expressions. A miss requires a message with none of them.
 *  - Anything the filter drops is logged at debug with the text, so gaps are
 *    discoverable from real traffic rather than guesswork.
 *
 * The general router in a later phase replaces this outright.
 */

const KEYWORD_PATTERNS: RegExp[] = [
  // Calendar nouns
  /\bcalendar(s)?\b/i,
  /\bevent(s)?\b/i,
  /\bmeeting(s)?\b/i,
  /\bappointment(s)?\b/i,
  /\bcall(s)?\b/i,
  /\bschedule(s|d)?\b/i,
  /\bbooking(s)?\b/i,
  /\breminder(s)?\b/i,
  /\bsync\b/i,
  /\bstandup\b/i,
  /\binterview(s)?\b/i,
  /\blunch|dinner|breakfast|coffee\b/i,

  // Action verbs
  /\b(re)?schedul(e|ing)\b/i,
  /\bbook\b/i,
  /\bcancel(l)?(ed|ing)?\b/i,
  /\bdelete\b/i,
  /\bmove\b/i,
  /\bpush\b/i,
  /\bpostpone\b/i,
  /\brearrange\b/i,
  /\bset up\b/i,
  /\bblock off\b/i,
  /\bpencil in\b/i,
  /\bfree\b/i,
  /\bbusy\b/i,
  /\bavailable|availability\b/i,

  // Time expressions
  /\btoday|tomorrow|tonight|yesterday\b/i,
  /\bnext (week|month|year|mon|tue|wed|thu|fri|sat|sun)/i,
  /\bthis (week|morning|afternoon|evening)\b/i,
  /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i,

  // Months, spelled out or abbreviated. Written as two explicit alternations
  // rather than a `(jan|feb|…)[a-z]*` prefix match: that shorter form also
  // matches "maybe", "decide", "separate", "market", and "jungle", which is a
  // large false-positive surface for no benefit.
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i,
  /\b\d{1,2}\s*(am|pm)\b/i,
  /\b\d{1,2}:\d{2}\b/i,
  /\bo'?clock\b/i,
  /\bat \d/i,
];

/**
 * @returns true if the message is plausibly calendar-related and should be
 *          sent to the classifier.
 */
export function looksCalendarRelated(text: string): boolean {
  return KEYWORD_PATTERNS.some((pattern) => pattern.test(text));
}
