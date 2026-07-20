import {
  RagHarness,
  buildRagJob,
  createRagHarness,
  destroyRagHarness,
  resetRagState,
  routeToRag,
  seedRagTenant,
} from '../rag-harness';

/**
 * Tenant isolation — the test that matters most in this phase.
 *
 * A second brain that answers one person's question from another person's
 * documents is not a bug to triage later; it is a data breach. Vector search has
 * no notion of ownership, so the only thing standing between two tenants is the
 * `WHERE user_id = ?` in VectorStoreService.
 *
 * These tests are deliberately adversarial: both tenants store *textually
 * similar* content, so a missing filter would produce confident cross-tenant
 * answers rather than obvious nonsense. Anything less would pass even with the
 * filter removed.
 */
describe('RAG tenant isolation (integration)', () => {
  let harness: RagHarness;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    harness = await createRagHarness();
  });

  afterAll(async () => {
    await destroyRagHarness(harness);
  });

  beforeEach(async () => {
    await resetRagState(harness);
    alice = await seedRagTenant(harness, 700_000_001);
    bob = await seedRagTenant(harness, 700_000_002);
  });

  const ALICE_SECRET =
    'Project Nightingale has a budget of 4.2 million dollars and ships in March.';
  const BOB_SECRET =
    'Project Nightingale has a budget of 9.9 million dollars and ships in December.';

  /**
   * Both tenants store near-identical text under the same topic, so every chunk
   * is a strong vector match for the other's query. Only the SQL filter
   * separates them.
   */
  async function seedBothTenants(): Promise<void> {
    harness.embeddings.register('nightingale', ALICE_SECRET, BOB_SECRET);
    harness.embeddings.register(
      'nightingale',
      'What is the Nightingale budget?',
    );

    await harness.ingestion.ingest(alice, {
      text: ALICE_SECRET,
      sourceType: 'text',
      sourceName: 'alice-notes.txt',
    });

    await harness.ingestion.ingest(bob, {
      text: BOB_SECRET,
      sourceType: 'text',
      sourceName: 'bob-notes.txt',
    });
  }

  it('stores each document against the right tenant', async () => {
    await seedBothTenants();

    const aliceDocs = await harness.prisma.document.findMany({
      where: { userId: alice },
    });
    const bobDocs = await harness.prisma.document.findMany({
      where: { userId: bob },
    });

    expect(aliceDocs).toHaveLength(1);
    expect(bobDocs).toHaveLength(1);
    expect(aliceDocs[0].sourceName).toBe('alice-notes.txt');
    expect(bobDocs[0].sourceName).toBe('bob-notes.txt');
  });

  it('denormalizes user_id onto every chunk', async () => {
    // The chunk's own user_id is what the vector query filters on. If it were
    // ever wrong or null, the filter would silently stop protecting anything.
    await seedBothTenants();

    const aliceChunks = await harness.prisma.documentChunk.findMany({
      where: { userId: alice },
      include: { document: true },
    });

    expect(aliceChunks.length).toBeGreaterThan(0);
    for (const chunk of aliceChunks) {
      expect(chunk.userId).toBe(alice);
      // And it must agree with the parent document's owner.
      expect(chunk.document.userId).toBe(alice);
    }
  });

  it('never returns another tenant’s chunks from a vector search', async () => {
    await seedBothTenants();

    const queryVector = await harness.embeddings.embedOne(
      'What is the Nightingale budget?',
      'query',
    );

    // A generous limit: if the filter were missing, both tenants' chunks are
    // near-identical matches and both would come back.
    const aliceResults = await harness.store.searchSimilar(
      alice,
      queryVector,
      50,
    );
    const bobResults = await harness.store.searchSimilar(bob, queryVector, 50);

    expect(aliceResults.length).toBeGreaterThan(0);
    expect(bobResults.length).toBeGreaterThan(0);

    for (const result of aliceResults) {
      expect(result.sourceName).toBe('alice-notes.txt');
      expect(result.content).not.toContain('9.9 million');
    }
    for (const result of bobResults) {
      expect(result.sourceName).toBe('bob-notes.txt');
      expect(result.content).not.toContain('4.2 million');
    }
  });

  it('answers each tenant only from their own document', async () => {
    await seedBothTenants();

    const aliceOutcome = await harness.retrieval.answer(
      alice,
      'What is the Nightingale budget?',
    );
    const bobOutcome = await harness.retrieval.answer(
      bob,
      'What is the Nightingale budget?',
    );

    expect(aliceOutcome.status).toBe('answered');
    expect(bobOutcome.status).toBe('answered');

    // The sources handed to the LLM are where a leak would actually occur —
    // the model can only repeat what it was given.
    const [aliceCall, bobCall] = harness.llm.answerCalls;

    expect(
      aliceCall.sources.every((s) => s.sourceName === 'alice-notes.txt'),
    ).toBe(true);
    expect(
      aliceCall.sources.some((s) => s.content.includes('9.9 million')),
    ).toBe(false);

    expect(bobCall.sources.every((s) => s.sourceName === 'bob-notes.txt')).toBe(
      true,
    );
    expect(bobCall.sources.some((s) => s.content.includes('4.2 million'))).toBe(
      false,
    );
  });

  it('cites only the querying tenant’s documents', async () => {
    await seedBothTenants();

    harness.llm.scriptIntent({
      intent: 'query',
      confidence: 'high',
      question: 'What is the Nightingale budget?',
    });

    await routeToRag(
      harness,
      buildRagJob(alice, 'what do my notes say about the Nightingale budget?'),
    );

    expect(harness.telegram.transcript).toContain('alice-notes.txt');
    expect(harness.telegram.transcript).not.toContain('bob-notes.txt');
  });

  it('tells a tenant with no documents that it has nothing, even when others do', async () => {
    // Bob has content that matches perfectly. Alice must still be told her own
    // brain is empty — not handed Bob's answer.
    harness.embeddings.register(
      'nightingale',
      BOB_SECRET,
      'Nightingale budget',
    );
    await harness.ingestion.ingest(bob, {
      text: BOB_SECRET,
      sourceType: 'text',
      sourceName: 'bob-notes.txt',
    });

    const outcome = await harness.retrieval.answer(
      alice,
      'What is the Nightingale budget?',
    );

    expect(outcome.status).toBe('no_documents');
    expect(harness.llm.answerCalls).toEqual([]);
  });

  it('scopes the chunk count per tenant', async () => {
    await seedBothTenants();

    expect(await harness.store.countChunks(alice)).toBeGreaterThan(0);
    expect(await harness.store.countChunks(bob)).toBeGreaterThan(0);

    const total = await harness.prisma.documentChunk.count();
    expect(
      (await harness.store.countChunks(alice)) +
        (await harness.store.countChunks(bob)),
    ).toBe(total);
  });

  it('deletes a tenant’s chunks with their documents, and touches no other tenant', async () => {
    await seedBothTenants();

    await harness.prisma.document.deleteMany({ where: { userId: alice } });

    expect(await harness.store.countChunks(alice)).toBe(0);
    expect(await harness.store.countChunks(bob)).toBeGreaterThan(0);
  });
});
