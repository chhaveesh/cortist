import { looksCalendarRelated } from '../../agents/calendar/intent/calendar-keyword-filter';
import { looksRagRelated } from '../../agents/rag/intent/rag-keyword-filter';

/**
 * The single pre-filter, in front of the one classification.
 *
 * Composed from the two agents' existing filters rather than a rewritten third
 * list: each was tuned against its own domain and has its own documented blind
 * spots and regression tests, and merging the regexes by hand would silently
 * discard that work.
 *
 * The union is strictly more permissive than either filter alone, so the known
 * recall risk shrinks: a message either filter would have passed still reaches
 * the classifier. Only a message BOTH would have dropped is dropped here.
 *
 * The tradeoff is unchanged and still real — a request phrased without any
 * listed keyword gets no reply at all. See DECISIONS.md §26.
 */
export function looksActionable(text: string): boolean {
  return looksCalendarRelated(text) || looksRagRelated(text);
}
