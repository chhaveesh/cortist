import { RouteName } from '../intent/route-intent.schema';

/**
 * Interpreting an answer to "did you mean your calendar, or your notes?".
 *
 * Deterministic rather than a second LLM call, for the same reasons as the
 * confirmation reply parser: the answer space is small and closed, the user is
 * waiting, and a model that misreads this would silently route the message to
 * the wrong agent — which is exactly the failure the question was asked to
 * prevent.
 */

// Plurals are matched explicitly (`docs?`, `notes?`): `\bdocument\b` does not
// match "documents", which is how most people would actually answer.
//
// Bare "one" and "two" are deliberately absent from both lists. "the second
// one" contains both "second" and "one", so including them made every ordinal
// answer match both candidates and resolve to null — the answer the user
// clearly did give. Ordinals are carried by first/second alone.
const CALENDAR_WORDS =
  /\b(calendars?|events?|meetings?|appointments?|reminders?|remind|schedule|diary|first|former|1st|1)\b/i;

const RAG_QUERY_WORDS =
  /\b(documents?|docs?|notes?|saved|files?|reports?|knowledge|brain|search|second|latter|2nd|2)\b/i;

const RAG_INGEST_WORDS = /\b(save|saving|store|remember|keep)\b/i;

/**
 * Resolves a reply to one of the two candidate routes, or null when the answer
 * does not clearly pick either.
 *
 * Only the two candidates are considered: a reply mentioning "notes" cannot
 * select rag_query if the question was between calendar and rag_ingest.
 */
export function interpretClarification(
  text: string,
  between: [RouteName, RouteName],
): RouteName | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const matches = new Set<RouteName>();

  for (const candidate of between) {
    switch (candidate) {
      case 'calendar':
        if (CALENDAR_WORDS.test(normalized)) matches.add('calendar');
        break;
      case 'rag_query':
        if (RAG_QUERY_WORDS.test(normalized)) matches.add('rag_query');
        break;
      case 'rag_ingest':
        // Checked before the query words: "save it to my notes" mentions both
        // "save" and "notes", and the verb is what disambiguates it.
        if (RAG_INGEST_WORDS.test(normalized)) matches.add('rag_ingest');
        else if (RAG_QUERY_WORDS.test(normalized)) matches.add('rag_ingest');
        break;
      case 'unrelated':
        break;
    }
  }

  // Mentioning both candidates is no clearer than mentioning neither.
  return matches.size === 1 ? [...matches][0] : null;
}
