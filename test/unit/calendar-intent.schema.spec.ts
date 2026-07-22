import { rebaseOntoDayOf } from '../../src/agents/calendar/calendar-agent.service';
import {
  CalendarExtraction,
  calendarExtractionJsonSchema,
  calendarExtractionSchema,
  narrowIntent,
} from '../../src/agents/calendar/intent/calendar-intent.schema';

function extraction(
  overrides: Partial<CalendarExtraction> = {},
): CalendarExtraction {
  return {
    intent: 'not_calendar_related',
    confidence: 'high',
    title: '',
    startTime: '',
    endTime: '',
    location: '',
    description: '',
    eventQuery: { titleContains: '', approximateStart: '', approximateEnd: '' },
    newStartTime: '',
    durationGiven: true,
    newDateGiven: false,
    newEndTime: '',
    clarifyingQuestion: '',
    ...overrides,
  };
}

describe('calendar extraction wire schema', () => {
  /**
   * The JSON schema and the zod schema are written out separately (the SDK's
   * zod helper targets zod v4, this project is on v3). This test is what stops
   * them drifting apart.
   */
  it('agrees with the zod schema on field names', () => {
    const jsonFields = Object.keys(
      calendarExtractionJsonSchema.properties,
    ).sort();
    const zodFields = Object.keys(calendarExtractionSchema.shape).sort();

    expect(jsonFields).toEqual(zodFields);
  });

  it('marks every field required, as structured outputs needs', () => {
    expect([...calendarExtractionJsonSchema.required].sort()).toEqual(
      Object.keys(calendarExtractionJsonSchema.properties).sort(),
    );
  });

  it('forbids additional properties at every level', () => {
    expect(calendarExtractionJsonSchema.additionalProperties).toBe(false);
    expect(
      calendarExtractionJsonSchema.properties.eventQuery.additionalProperties,
    ).toBe(false);
  });

  it('uses no constraint keywords that structured outputs rejects', () => {
    // minLength / maximum / multipleOf and friends are unsupported and would
    // make the API reject the whole request.
    const serialized = JSON.stringify(calendarExtractionJsonSchema);
    for (const banned of [
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'multipleOf',
      'minItems',
      'maxItems',
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('accepts a well-formed extraction', () => {
    expect(calendarExtractionSchema.safeParse(extraction()).success).toBe(true);
  });
});

describe('narrowIntent', () => {
  it('narrows a complete create_event', () => {
    const result = narrowIntent(
      extraction({
        intent: 'create_event',
        title: 'Dentist',
        startTime: '2026-07-20T09:00:00+01:00',
        endTime: '2026-07-20T10:00:00+01:00',
        durationGiven: true,
        location: 'Harley St',
      }),
    );

    expect(result).toEqual({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00+01:00',
      endTime: '2026-07-20T10:00:00+01:00',
      durationGiven: true,
      location: 'Harley St',
    });
  });

  it.each([
    [
      'no title',
      {
        title: '',
        startTime: '2026-07-20T09:00:00Z',
        endTime: '2026-07-20T10:00:00Z',
      },
    ],
    [
      'no start',
      { title: 'Dentist', startTime: '', endTime: '2026-07-20T10:00:00Z' },
    ],
    [
      'no end',
      { title: 'Dentist', startTime: '2026-07-20T09:00:00Z', endTime: '' },
    ],
    [
      'whitespace title',
      {
        title: '   ',
        startTime: '2026-07-20T09:00:00Z',
        endTime: '2026-07-20T10:00:00Z',
      },
    ],
  ])(
    'downgrades an incomplete create_event to clarification (%s)',
    (_name, overrides) => {
      // Guessing a missing title or time is how you end up with a wrong entry
      // in someone's real calendar — asking is the correct failure mode.
      const result = narrowIntent(
        extraction({ intent: 'create_event', ...overrides }),
      );
      expect(result.intent).toBe('needs_clarification');
    },
  );

  it('narrows a complete reschedule_event', () => {
    const result = narrowIntent(
      extraction({
        intent: 'reschedule_event',
        eventQuery: {
          titleContains: 'standup',
          approximateStart: '2026-07-20T00:00:00Z',
          approximateEnd: '2026-07-21T00:00:00Z',
        },
        newStartTime: '2026-07-20T11:00:00+01:00',
      }),
    );

    expect(result.intent).toBe('reschedule_event');
    if (result.intent === 'reschedule_event') {
      expect(result.newStartTime).toBe('2026-07-20T11:00:00+01:00');
      expect(result.newEndTime).toBeUndefined();
      expect(result.eventQuery.titleContains).toBe('standup');
    }
  });

  it('downgrades a reschedule with no new time', () => {
    const result = narrowIntent(
      extraction({
        intent: 'reschedule_event',
        eventQuery: {
          titleContains: 'standup',
          approximateStart: '',
          approximateEnd: '',
        },
        newStartTime: '',
      }),
    );
    expect(result.intent).toBe('needs_clarification');
  });

  it('downgrades a reschedule with nothing to identify the event', () => {
    const result = narrowIntent(
      extraction({
        intent: 'reschedule_event',
        newStartTime: '2026-07-20T11:00:00Z',
      }),
    );
    expect(result.intent).toBe('needs_clarification');
  });

  it('narrows a delete_event with a usable query', () => {
    const result = narrowIntent(
      extraction({
        intent: 'delete_event',
        eventQuery: {
          titleContains: 'dentist',
          approximateStart: '',
          approximateEnd: '',
        },
      }),
    );
    expect(result.intent).toBe('delete_event');
  });

  it('downgrades a delete_event with an empty query', () => {
    const result = narrowIntent(extraction({ intent: 'delete_event' }));
    expect(result.intent).toBe('needs_clarification');
  });

  it('passes through an explicit clarification question', () => {
    const result = narrowIntent(
      extraction({
        intent: 'needs_clarification',
        clarifyingQuestion: 'Which of your three calls did you mean?',
      }),
    );

    expect(result).toEqual({
      intent: 'needs_clarification',
      confidence: 'high',
      question: 'Which of your three calls did you mean?',
    });
  });

  it('substitutes a fallback when the question is blank', () => {
    const result = narrowIntent(extraction({ intent: 'needs_clarification' }));
    expect(result.intent).toBe('needs_clarification');
    if (result.intent === 'needs_clarification') {
      expect(result.question.length).toBeGreaterThan(0);
    }
  });

  it('passes through not_calendar_related', () => {
    expect(narrowIntent(extraction({ confidence: 'low' }))).toEqual({
      intent: 'not_calendar_related',
      confidence: 'low',
    });
  });
});

/**
 * query_events — the read-only action.
 *
 * Added after the router sent "what's on my calendar tomorrow?" to `unrelated`
 * and the model explained exactly why: the assistant could create, move, and
 * delete events, but not look at them. The README's own onboarding step relied
 * on that message reaching the calendar agent, so a new user had no way to get
 * an OAuth link.
 */
describe('query_events narrowing', () => {
  function raw(overrides: Record<string, unknown> = {}) {
    return {
      intent: 'query_events',
      confidence: 'high',
      title: '',
      startTime: '',
      endTime: '',
      location: '',
      description: '',
      eventQuery: {
        titleContains: '',
        approximateStart: '',
        approximateEnd: '',
      },
      newStartTime: '',
      newEndTime: '',
      clarifyingQuestion: '',
      ...overrides,
    } as never;
  }

  it('keeps a window the model supplied', () => {
    const intent = narrowIntent(
      raw({
        startTime: '2026-07-24T00:00:00+05:30',
        endTime: '2026-07-25T00:00:00+05:30',
      }),
    );

    expect(intent).toEqual({
      intent: 'query_events',
      confidence: 'high',
      startTime: '2026-07-24T00:00:00+05:30',
      endTime: '2026-07-25T00:00:00+05:30',
    });
  });

  /**
   * The opposite of the create/reschedule/delete gates, deliberately. Those
   * downgrade an incomplete request to a question because acting on a bad guess
   * writes something wrong into a real calendar. A query writes nothing, so an
   * empty window is a normal request and the agent defaults it.
   */
  it('does not demand a window', () => {
    const intent = narrowIntent(raw());

    expect(intent.intent).toBe('query_events');
    expect(intent).not.toHaveProperty('startTime');
    expect(intent).not.toHaveProperty('endTime');
  });

  it('accepts a start with no end', () => {
    const intent = narrowIntent(raw({ startTime: '2026-07-24T00:00:00Z' }));

    expect(intent).toEqual({
      intent: 'query_events',
      confidence: 'high',
      startTime: '2026-07-24T00:00:00Z',
    });
  });
});

/**
 * Rebasing a bare time onto the event's own day.
 *
 * The bug this fixes, observed against a real calendar on 2026-07-23: "move my
 * dentist appointment to 5pm" was proposed as a move from Fri 24 Jul 15:00 to
 * *Thu 23 Jul* 17:00 — a day earlier. The classifier is asked for an absolute
 * timestamp but never sees the event, so "5pm" can only anchor to today. The
 * agent knows the event, so the arithmetic belongs there.
 */
describe('rebaseOntoDayOf', () => {
  it('keeps the event on its own day', () => {
    // Event on Fri 24 Jul; model said 5pm and anchored to Thu 23 Jul.
    expect(
      rebaseOntoDayOf(
        '2026-07-24T15:00:00+05:30',
        '2026-07-23T17:00:00+05:30',
        'Asia/Kolkata',
      ),
    ).toBe('2026-07-24T17:00:00+05:30');
  });

  it('works when the event and the guess are in different UTC days', () => {
    // 24 Jul 23:30 IST is still 24 Jul locally but 18:00 UTC — the rebase must
    // use the user's calendar day, not UTC's.
    expect(
      rebaseOntoDayOf(
        '2026-07-24T23:30:00+05:30',
        '2026-07-23T09:00:00+05:30',
        'Asia/Kolkata',
      ),
    ).toBe('2026-07-24T09:00:00+05:30');
  });

  it('carries the target day’s offset, not the guess’s', () => {
    // London in July is BST (+01:00).
    expect(
      rebaseOntoDayOf(
        '2026-07-24T15:00:00+01:00',
        '2026-07-23T17:00:00+01:00',
        'Europe/London',
      ),
    ).toBe('2026-07-24T17:00:00+01:00');
  });

  it('falls back to the model’s timestamp on an unusable input', () => {
    // A bad date must not turn a reschedule into an error.
    expect(
      rebaseOntoDayOf('not-a-date', '2026-07-23T17:00:00Z', 'Asia/Kolkata'),
    ).toBe('2026-07-23T17:00:00Z');
  });
});
