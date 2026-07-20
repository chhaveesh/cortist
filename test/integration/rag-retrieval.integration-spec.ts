import {
  RagHarness,
  buildRagJob,
  createRagHarness,
  destroyRagHarness,
  resetRagState,
  seedRagTenant,
} from '../rag-harness';

/**
 * Retrieval, with the honesty gates that matter most for a second brain.
 *
 * A confident wrong answer is worse than no answer here — the whole value of
 * the feature is that you can trust what it tells you about your own notes.
 */
describe('RAG retrieval (integration)', () => {
  let harness: RagHarness;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createRagHarness();
  });

  afterAll(async () => {
    await destroyRagHarness(harness);
  });

  beforeEach(async () => {
    await resetRagState(harness);
    tenantId = await seedRagTenant(harness, 720_000_001);
  });

  const REPORT =
    'Q4 revenue reached 4.2 million dollars, up 18 percent year over year.';

  async function storeReport(): Promise<void> {
    harness.embeddings.register('revenue', REPORT, 'What was Q4 revenue?');
    await harness.ingestion.ingest(tenantId, {
      text: REPORT,
      sourceType: 'pdf',
      sourceName: 'quarterly-report.pdf',
    });
  }

  it('answers from a stored document and cites its source', async () => {
    await storeReport();

    const outcome = await harness.retrieval.answer(
      tenantId,
      'What was Q4 revenue?',
    );

    expect(outcome.status).toBe('answered');
    if (outcome.status === 'answered') {
      expect(outcome.citations).toEqual(['quarterly-report.pdf']);
    }

    // The model was handed the real chunk, not a paraphrase of it.
    expect(harness.llm.answerCalls[0].sources[0].content).toContain(
      '4.2 million',
    );
  });

  it('names the source in the reply the user actually sees', async () => {
    await storeReport();
    harness.llm.scriptIntent({
      intent: 'query',
      confidence: 'high',
      question: 'What was Q4 revenue?',
    });

    await harness.agent.handle(
      buildRagJob(tenantId, 'what did the report say about Q4 revenue?'),
    );

    expect(harness.telegram.transcript).toContain('quarterly-report.pdf');
    expect(harness.telegram.transcript).toContain('Sources:');
  });

  it('embeds the question as a query, not as a document', async () => {
    await storeReport();
    harness.embeddings.calls.length = 0;

    await harness.retrieval.answer(tenantId, 'What was Q4 revenue?');

    expect(harness.embeddings.calls[0].inputType).toBe('query');
  });

  describe('honesty gates', () => {
    it('says it has nothing when the tenant has stored nothing', async () => {
      const outcome = await harness.retrieval.answer(tenantId, 'anything?');

      expect(outcome.status).toBe('no_documents');
      // No LLM call at all — there is nothing to ground an answer in.
      expect(harness.llm.answerCalls).toEqual([]);
    });

    it('refuses to answer when nothing clears the similarity floor', async () => {
      // The gate that matters. Vector search always returns its nearest
      // neighbours, even when the nearest thing is unrelated — without a floor
      // the model gets irrelevant context that reads as authoritative.
      await storeReport();

      const outcome = await harness.retrieval.answer(
        tenantId,
        'How do I repair a bicycle chain?',
      );

      expect(outcome.status).toBe('nothing_relevant');
      expect(harness.llm.answerCalls).toEqual([]);
    });

    it('reports honestly rather than guessing, in the user-facing reply', async () => {
      await storeReport();
      harness.llm.scriptIntent({
        intent: 'query',
        confidence: 'high',
        question: 'How do I repair a bicycle chain?',
      });

      const outcome = await harness.agent.handle(
        buildRagJob(tenantId, 'what do my notes say about bicycle repair?'),
      );

      expect(outcome.status).toBe('nothing_relevant');
      expect(harness.telegram.transcript).toMatch(
        /couldn't find|rather not guess/,
      );
      // Crucially, it does not answer from general knowledge.
      expect(harness.telegram.transcript).not.toContain('chain');
    });

    it('respects the model declining even when chunks cleared the floor', async () => {
      // Second gate: the chunks were close enough to retrieve, but do not
      // actually contain the answer. The model says so, and we pass that on
      // rather than shipping its empty answer.
      await storeReport();
      harness.llm.setAnswer({
        answer: '',
        answered: false,
        usedSourceIndices: [],
      });

      const outcome = await harness.retrieval.answer(
        tenantId,
        'What was Q4 revenue?',
      );

      expect(outcome.status).toBe('nothing_relevant');
    });

    it('does not cite sources it did not use', async () => {
      harness.embeddings.register(
        'revenue',
        REPORT,
        'Headcount grew to 19 people.',
        'What was Q4 revenue?',
      );
      await harness.ingestion.ingest(tenantId, {
        text: REPORT,
        sourceType: 'pdf',
        sourceName: 'quarterly-report.pdf',
      });
      await harness.ingestion.ingest(tenantId, {
        text: 'Headcount grew to 19 people.',
        sourceType: 'text',
        sourceName: 'headcount-notes.txt',
      });

      harness.llm.setAnswer({
        answer: 'Revenue was 4.2 million dollars.',
        answered: true,
        usedSourceIndices: [0],
      });

      const outcome = await harness.retrieval.answer(
        tenantId,
        'What was Q4 revenue?',
      );

      expect(outcome.status).toBe('answered');
      if (outcome.status === 'answered') {
        expect(outcome.citations).toHaveLength(1);
      }
    });

    it('falls back to citing every retrieved source when indices are unusable', async () => {
      // An answer with a slightly over-broad citation beats one with no
      // attribution — attribution is the point of the feature.
      await storeReport();
      harness.llm.setAnswer({
        answer: 'Revenue was 4.2 million dollars.',
        answered: true,
        usedSourceIndices: [99],
      });

      const outcome = await harness.retrieval.answer(
        tenantId,
        'What was Q4 revenue?',
      );

      expect(outcome.status).toBe('answered');
      if (outcome.status === 'answered') {
        expect(outcome.citations).toEqual(['quarterly-report.pdf']);
      }
    });
  });

  describe('search limit validation', () => {
    /**
     * Prisma binds a raw-query parameter by its JS type, so a string `limit`
     * reaches Postgres as text and the query dies with "argument of LIMIT must
     * be type bigint, not type text" — an error naming neither the parameter
     * nor the caller. Found by driving the service without the config layer's
     * zod coercion in front of it.
     */
    it('accepts a numeric string rather than failing at the database', async () => {
      await storeReport();
      const vector = await harness.embeddings.embedOne(
        'What was Q4 revenue?',
        'query',
      );

      await expect(
        harness.store.searchSimilar(tenantId, vector, '3' as unknown as number),
      ).resolves.toBeInstanceOf(Array);
    });

    it.each([0, -1, 1.5, NaN, 'abc', null, undefined])(
      'rejects an invalid limit (%s) with a clear message',
      async (limit) => {
        await storeReport();
        const vector = await harness.embeddings.embedOne('q', 'query');

        await expect(
          harness.store.searchSimilar(
            tenantId,
            vector,
            limit as unknown as number,
          ),
        ).rejects.toThrow(/limit must be a positive integer/i);
      },
    );
  });

  it('deduplicates citations when several chunks share a document', async () => {
    const long = Array.from(
      { length: 30 },
      () => 'Q4 revenue reached 4.2 million dollars in the period.',
    ).join('\n\n');

    harness.embeddings.register(
      'revenue',
      long,
      'Q4 revenue',
      'What was Q4 revenue?',
    );
    await harness.ingestion.ingest(tenantId, {
      text: long,
      sourceType: 'pdf',
      sourceName: 'quarterly-report.pdf',
    });

    harness.llm.setAnswer({
      answer: '4.2 million.',
      answered: true,
      usedSourceIndices: [0, 1, 2],
    });

    const outcome = await harness.retrieval.answer(
      tenantId,
      'What was Q4 revenue?',
    );

    if (outcome.status === 'answered') {
      expect(outcome.citations).toEqual(['quarterly-report.pdf']);
    }
  });
});
