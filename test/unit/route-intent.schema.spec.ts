import {
  RouteExtraction,
  describeRoute,
  isAmbiguous,
  narrowRoute,
  routeExtractionJsonSchema,
  routeExtractionSchema,
} from '../../src/router/intent/route-intent.schema';

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
    contentToStore: '',
    question: '',
    clarifyingQuestion: '',
    ...overrides,
  };
}

describe('router wire schema', () => {
  it('agrees with the zod schema on field names', () => {
    expect(Object.keys(routeExtractionJsonSchema.properties).sort()).toEqual(
      Object.keys(routeExtractionSchema.shape).sort(),
    );
  });

  it('marks every field required, as structured outputs needs', () => {
    expect([...routeExtractionJsonSchema.required].sort()).toEqual(
      Object.keys(routeExtractionJsonSchema.properties).sort(),
    );
  });

  it('forbids additional properties at every level', () => {
    expect(routeExtractionJsonSchema.additionalProperties).toBe(false);
    expect(
      routeExtractionJsonSchema.properties.eventQuery.additionalProperties,
    ).toBe(false);
  });

  it('uses no constraint keywords structured outputs rejects', () => {
    const serialized = JSON.stringify(routeExtractionJsonSchema);
    for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum']) {
      expect(serialized).not.toContain(banned);
    }
  });
});

describe('isAmbiguous', () => {
  /**
   * Ambiguous ⟺ confidence is not high AND a *different* alternative exists.
   *
   * Both halves carry weight, and the cases below are the reason. Loosening
   * either one interrupts users more often; tightening misroutes more often.
   */
  it('is ambiguous when unsure between two real options', () => {
    expect(
      isAmbiguous(
        extraction({
          route: 'calendar',
          confidence: 'medium',
          alternative: 'rag_query',
        }),
      ),
    ).toBe(true);
  });

  it('is NOT ambiguous when the model is confident, even with an alternative', () => {
    // A named runner-up at high confidence means the model considered a second
    // reading and dismissed it — which is the judgement we want it to make
    // rather than escalating to the user.
    expect(
      isAmbiguous(
        extraction({
          route: 'calendar',
          confidence: 'high',
          alternative: 'rag_query',
        }),
      ),
    ).toBe(false);
  });

  it('is NOT ambiguous when unsure but with no alternative', () => {
    // "Did you mean A or B?" is useless when there is no B. This routes anyway
    // and lets the agent's own clarification handle an underspecified request.
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

  it('is NOT ambiguous when the alternative equals the route', () => {
    // A model naming its own choice as the runner-up is not expressing doubt
    // between two options.
    expect(
      isAmbiguous(
        extraction({
          route: 'calendar',
          confidence: 'low',
          alternative: 'calendar',
        }),
      ),
    ).toBe(false);
  });
});

describe('narrowRoute', () => {
  it('narrows a confident calendar create, delegating to the agent’s rules', () => {
    const result = narrowRoute(
      extraction({
        route: 'calendar',
        calendarAction: 'create_event',
        title: 'Dentist',
        startTime: '2026-07-21T09:00:00+01:00',
        endTime: '2026-07-21T10:00:00+01:00',
      }),
    );

    expect(result.route).toBe('calendar');
    if (result.route === 'calendar') {
      expect(result.intent.intent).toBe('create_event');
      if (result.intent.intent === 'create_event') {
        expect(result.intent.title).toBe('Dentist');
      }
    }
  });

  it('inherits the calendar agent’s downgrade of an incomplete request', () => {
    // The agent's own narrowing turns a create with no time into a clarifying
    // question. Reusing it means the router cannot diverge from that rule.
    const result = narrowRoute(
      extraction({
        route: 'calendar',
        calendarAction: 'create_event',
        title: 'Dentist',
      }),
    );

    expect(result.route).toBe('calendar');
    if (result.route === 'calendar') {
      expect(result.intent.intent).toBe('needs_clarification');
    }
  });

  it('narrows a rag_ingest into the agent’s store intent', () => {
    const result = narrowRoute(
      extraction({ route: 'rag_ingest', contentToStore: 'remember this fact' }),
    );

    expect(result.route).toBe('rag_ingest');
    if (result.route === 'rag_ingest') {
      expect(result.intent).toEqual({
        intent: 'store',
        confidence: 'high',
        content: 'remember this fact',
      });
    }
  });

  it('narrows a rag_query into the agent’s query intent', () => {
    const result = narrowRoute(
      extraction({ route: 'rag_query', question: 'what was Q4 revenue?' }),
    );

    expect(result.route).toBe('rag_query');
    if (result.route === 'rag_query') {
      expect(result.intent).toEqual({
        intent: 'query',
        confidence: 'high',
        question: 'what was Q4 revenue?',
      });
    }
  });

  it('inherits the RAG agent’s rejection of an empty payload', () => {
    // Storing nothing or searching for nothing both produce confidently
    // useless results, so neither is allowed through.
    const result = narrowRoute(
      extraction({ route: 'rag_ingest', contentToStore: '   ' }),
    );

    if (result.route === 'rag_ingest') {
      expect(result.intent.intent).toBe('not_rag_related');
    }
  });

  it('reports ambiguity with both candidates, so the question can name them', () => {
    const result = narrowRoute(
      extraction({
        route: 'calendar',
        confidence: 'medium',
        alternative: 'rag_query',
        reason: 'could be a reminder or a lookup',
      }),
    );

    expect(result.route).toBe('ambiguous');
    if (result.route === 'ambiguous') {
      expect(result.between).toEqual(['calendar', 'rag_query']);
    }
  });

  it('passes through unrelated', () => {
    expect(narrowRoute(extraction()).route).toBe('unrelated');
  });
});

describe('describeRoute', () => {
  it('describes every route in language a user would recognise', () => {
    for (const route of [
      'calendar',
      'rag_query',
      'rag_ingest',
      'unrelated',
    ] as const) {
      const described = describeRoute(route);
      expect(described.length).toBeGreaterThan(0);
      // No internal identifiers leaking into something a person reads.
      expect(described).not.toMatch(/rag_|_event|unrelated/);
    }
  });
});
