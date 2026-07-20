/**
 * Cheap pre-filter before the RAG classifier, mirroring the calendar agent's.
 *
 * Same tradeoff, same caveat: it trades recall for one saved LLM call per
 * message, and a missed request fails invisibly. The list is generous, and
 * `rag-keyword-filter.spec.ts` pins the known blind spots.
 *
 * Note it deliberately does NOT try to be clever about questions. A bare
 * question is ambiguous between "answer from my documents" and general chat,
 * which is precisely the judgement the classifier exists to make — so anything
 * question-shaped is passed through to it.
 */

const PATTERNS: RegExp[] = [
  // Explicit storage triggers
  /\bsave (this|that|it)\b/i,
  /\bremember (this|that|it)\b/i,
  /\bnote (this|that|it)( down)?\b/i,
  /\bkeep (this|that|it)\b/i,
  /\bstore (this|that|it)\b/i,
  /\badd (this|that|it) to (my )?(notes|brain|knowledge)\b/i,
  /\bfile (this|that|it) (under|away)\b/i,

  // Knowledge-base vocabulary
  /\b(my )?(notes?|documents?|docs?|files?|brain|knowledge base)\b/i,
  /\bwhat did .* (say|mention|state)\b/i,
  /\baccording to\b/i,
  // Allows a modifier or two between the article and the noun: "the Q3
  // report" and "the quarterly report" both failed the stricter form, which
  // dropped a whole class of plausible requests before classification.
  /\bthe (\w+ ){0,2}(reports?|papers?|articles?|docs?|documents?|pdfs?)\b/i,
  /\bi (saved|stored|uploaded|sent you)\b/i,

  // Question shapes — resolved by the classifier, not here
  /\bwhat do i know about\b/i,
  /\bwhat does .* say\b/i,
  /^(what|who|when|where|why|how|which)\b/i,
  /\?\s*$/,

  // A bare URL is a "remember this page" request
  /https?:\/\/\S+/i,
];

export function looksRagRelated(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The first http(s) URL in a message, with common trailing punctuation removed
 * so a link at the end of a sentence does not carry the full stop into the
 * request.
 */
export function firstUrlIn(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]}]+$/, '');
}
