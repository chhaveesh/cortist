import { interpretClarification } from '../../src/router/clarification/clarification-reply';
import { looksActionable } from '../../src/router/intent/router-keyword-filter';

describe('interpretClarification', () => {
  const calendarVsQuery = ['calendar', 'rag_query'] as const;

  it.each([
    'the calendar one',
    'calendar',
    'my calendar please',
    'the meeting',
    'set a reminder',
    'the first one',
  ])('picks calendar from %s', (text) => {
    expect(interpretClarification(text, [...calendarVsQuery])).toBe('calendar');
  });

  it.each([
    'my documents',
    'the saved doc',
    'my notes',
    'the report',
    'the second one',
  ])('picks the document route from %s', (text) => {
    expect(interpretClarification(text, [...calendarVsQuery])).toBe(
      'rag_query',
    );
  });

  it.each(['maybe', 'both?', 'what do you mean', '', '   ', 'yes'])(
    'returns null for an unclear answer: %s',
    (text) => {
      expect(interpretClarification(text, [...calendarVsQuery])).toBeNull();
    },
  );

  it('returns null when the answer names both candidates', () => {
    // Mentioning both is no clearer than mentioning neither — guessing here
    // would defeat the point of having asked.
    expect(
      interpretClarification('the calendar or my notes?', [...calendarVsQuery]),
    ).toBeNull();
  });

  it('only considers the two candidates actually offered', () => {
    // "notes" cannot select rag_query when the question was calendar vs ingest.
    expect(interpretClarification('my notes', ['calendar', 'rag_ingest'])).toBe(
      'rag_ingest',
    );
  });

  it('prefers the storing verb over the noun for an ingest candidate', () => {
    // "save it to my notes" contains both; the verb is what disambiguates.
    expect(
      interpretClarification('save it to my notes', ['calendar', 'rag_ingest']),
    ).toBe('rag_ingest');
  });
});

describe('looksActionable', () => {
  it.each([
    'book a dentist appointment tomorrow',
    'cancel my 3pm meeting',
    'save this: the API limit is 1000/min',
    'what did the report say about Q4?',
    'https://example.com/article',
  ])('passes an actionable message through to the classifier: %s', (text) => {
    expect(looksActionable(text)).toBe(true);
  });

  it.each(['thanks!', 'ok cool', 'hello there'])(
    'filters out chit-chat: %s',
    (text) => {
      expect(looksActionable(text)).toBe(false);
    },
  );

  /**
   * The union of both agents' filters is strictly more permissive than either
   * alone, so the documented recall risk shrinks rather than growing: a message
   * either filter would have passed still reaches the classifier.
   */
  it('passes anything either agent’s filter would have passed', () => {
    // Calendar-only vocabulary.
    expect(looksActionable('reschedule it')).toBe(true);
    // RAG-only vocabulary.
    expect(looksActionable('add this to my knowledge base')).toBe(true);
  });
});
