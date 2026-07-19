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
        location: 'Harley St',
      }),
    );

    expect(result).toEqual({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00+01:00',
      endTime: '2026-07-20T10:00:00+01:00',
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
