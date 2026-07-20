import {
  RouteExtraction,
  isAmbiguous,
  narrowRoute,
} from '../../src/router/intent/route-intent.schema';
import { looksActionable } from '../../src/router/intent/router-keyword-filter';

/**
 * Ambiguity detection, from both directions.
 *
 * Over-triggering is a failure mode in its own right, not a safe default: a
 * user interrupted with "did you mean X or Y?" on a request they stated
 * perfectly clearly learns the assistant is not listening. These fixtures pin
 * both sides — genuinely dual-plausible phrasings must ask, and
 * confidently-classifiable ones must not.
 *
 * Note what these test and what they do not. The threshold logic is ours and is
 * tested exactly. Whether the *model* assigns the right confidence and
 * alternative to a given phrasing is its judgement, and no mock can verify it —
 * each fixture below therefore records the classification a careful human would
 * expect, and `npm run eval:intent` is where that expectation meets reality.
 */

function extraction(overrides: Partial<RouteExtraction> = {}): RouteExtraction {
  return {
    route: 'unrelated',
    confidence: 'high',
    alternative: 'none',
    reason: 'test',
    calendarAction: 'create_event',
    title: '',
    startTime: '',
    endTime: '',
    location: '',
    description: '',
    eventQuery: { titleContains: '', approximateStart: '', approximateEnd: '' },
    newStartTime: '',
    newEndTime: '',
    clarifyingQuestion: '',
    contentToStore: '',
    question: '',
    ...overrides,
  };
}

/**
 * Phrasings that genuinely admit two readings.
 *
 * Each names the two plausible routes. "Remind me about the Q3 report" is the
 * canonical case: a calendar reminder and a lookup in saved documents are both
 * entirely reasonable readings, and picking one silently is how the assistant
 * does the wrong thing confidently.
 */
const GENUINELY_AMBIGUOUS: Array<{
  text: string;
  between: [RouteExtraction['route'], RouteExtraction['route']];
  why: string;
}> = [
  {
    text: 'remind me about the Q3 report',
    between: ['calendar', 'rag_query'],
    why: 'a reminder to set, or a document to look up',
  },
  {
    text: "what's happening with the client thing",
    between: ['calendar', 'rag_query'],
    why: 'upcoming meetings, or notes about the client',
  },
  {
    text: "note about tomorrow's meeting",
    between: ['calendar', 'rag_ingest'],
    why: 'create the meeting, or save a note about it',
  },
  {
    text: 'the budget doc for Thursday',
    between: ['calendar', 'rag_query'],
    why: 'a Thursday event, or a document to retrieve',
  },
  {
    text: 'keep this in mind for next week',
    between: ['calendar', 'rag_ingest'],
    why: 'schedule something, or remember something',
  },
];

/**
 * The inverse — messages that *mention* both domains but state their intent
 * plainly. These must route without interrupting the user.
 */
const CONFIDENTLY_CLASSIFIABLE: Array<{
  text: string;
  route: RouteExtraction['route'];
  why: string;
}> = [
  {
    text: 'create a calendar event to review the Q3 report tomorrow at 3pm',
    route: 'calendar',
    why: 'names the action and the time; the report is only the subject',
  },
  {
    text: 'save this: the Q3 report says revenue grew 18 percent',
    route: 'rag_ingest',
    why: 'explicit storage trigger',
  },
  {
    text: 'what did the Q3 report say about revenue?',
    route: 'rag_query',
    why: 'a question about stored material, not a scheduling request',
  },
  {
    text: 'cancel my dentist appointment on Friday',
    route: 'calendar',
    why: 'unambiguous calendar verb and object',
  },
];

describe('ambiguity detection', () => {
  describe('genuinely ambiguous phrasings', () => {
    it.each(GENUINELY_AMBIGUOUS)(
      'asks rather than guessing: "$text" ($why)',
      ({ text, between }) => {
        // The model reports medium confidence with a named runner-up.
        const raw = extraction({
          route: between[0],
          confidence: 'medium',
          alternative: between[1],
          reason: text,
        });

        expect(isAmbiguous(raw)).toBe(true);

        const decision = narrowRoute(raw);
        expect(decision.route).toBe('ambiguous');
        if (decision.route === 'ambiguous') {
          expect(decision.between).toEqual(between);
        }
      },
    );

    it.each(GENUINELY_AMBIGUOUS)(
      'reaches the classifier at all: "$text"',
      ({ text }) => {
        // A phrasing dropped by the pre-filter can never be clarified, however
        // good the ambiguity logic is. "remind me about the Q3 report" was
        // silently dropped until Phase 4a — the filter matched the noun
        // "reminder" but not the verb "remind".
        expect(looksActionable(text)).toBe(true);
      },
    );
  });

  describe('confidently classifiable phrasings', () => {
    it.each(CONFIDENTLY_CLASSIFIABLE)(
      'routes without interrupting the user: "$text" ($why)',
      ({ text, route }) => {
        // High confidence, and the model may still name a runner-up — mentioning
        // a document in a calendar request is normal and must not trigger a
        // question.
        const raw = extraction({
          route,
          confidence: 'high',
          alternative: route === 'calendar' ? 'rag_query' : 'calendar',
          reason: text,
          ...(route === 'calendar'
            ? {
                calendarAction: 'create_event',
                title: 'Review Q3 report',
                startTime: '2026-07-21T15:00:00+01:00',
                endTime: '2026-07-21T16:00:00+01:00',
              }
            : {}),
          ...(route === 'rag_ingest' ? { contentToStore: text } : {}),
          ...(route === 'rag_query' ? { question: text } : {}),
        });

        expect(isAmbiguous(raw)).toBe(false);
        expect(narrowRoute(raw).route).toBe(route);
      },
    );

    it('does not ask when the model is unsure but sees no alternative', () => {
      // Low confidence with no runner-up is not ambiguity — there is no second
      // option to offer. Asking "did you mean A or...?" would be nonsense, so
      // this routes and lets the agent's own clarification handle a request
      // that is merely underspecified.
      expect(
        isAmbiguous(
          extraction({
            route: 'calendar',
            confidence: 'low',
            alternative: 'none',
          }),
        ),
      ).toBe(false);
    });
  });

  /**
   * The dial, stated as a table so the policy is legible in one place rather
   * than inferred from the implementation.
   */
  describe('the threshold, exhaustively', () => {
    const cases: Array<[RouteExtraction['confidence'], string, boolean]> = [
      ['high', 'none', false],
      ['high', 'rag_query', false],
      ['medium', 'none', false],
      ['medium', 'rag_query', true],
      ['low', 'none', false],
      ['low', 'rag_query', true],
      ['low', 'calendar', false],
    ];

    it.each(cases)(
      'confidence=%s alternative=%s → ambiguous=%s',
      (confidence, alternative, expected) => {
        expect(
          isAmbiguous(
            extraction({
              route: 'calendar',
              confidence,
              alternative: alternative as RouteExtraction['alternative'],
            }),
          ),
        ).toBe(expected);
      },
    );
  });
});
