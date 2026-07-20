import {
  RouterHarness,
  connectRouterCalendar,
  createRouterHarness,
  destroyRouterHarness,
  resetRouterState,
  routerJob,
  seedRouterTenant,
} from '../router-harness';

/**
 * Phase 2 and Phase 3 safety properties, re-proved THROUGH the router.
 *
 * The refactor moved classification out of both agents and changed how they are
 * entered. Testing the router in isolation says nothing about whether those
 * agents still behave correctly on the new path, and every property below is
 * one where a silent regression would be genuinely damaging: a deleted event
 * nobody confirmed, one tenant's documents answering another's question, a
 * double-booked calendar.
 *
 * These deliberately duplicate scenarios already covered directly. That is the
 * point — the earlier suites prove the agent works when called directly, and
 * these prove the router calls it correctly.
 */
describe('Phase 2 + 3 regressions through the router (integration)', () => {
  let harness: RouterHarness;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createRouterHarness();
  });

  afterAll(async () => {
    await destroyRouterHarness(harness);
  });

  beforeEach(async () => {
    await resetRouterState(harness);
    tenantId = await seedRouterTenant(harness);
  });

  // -------------------------------------------------------------------------
  // Calendar (Phase 2)
  // -------------------------------------------------------------------------

  describe('calendar', () => {
    const createDentist = {
      route: 'calendar' as const,
      calendarAction: 'create_event' as const,
      title: 'Dentist',
      startTime: '2026-07-21T09:00:00Z',
      endTime: '2026-07-21T10:00:00Z',
    };

    it('still detects conflicts and creates nothing when the slot is taken', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.calendarClient.seed([
        {
          id: 'existing',
          title: 'Team standup',
          start: '2026-07-21T09:30:00Z',
          end: '2026-07-21T10:30:00Z',
        },
      ]);
      harness.classifier.script(createDentist);

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'book a dentist appointment tomorrow at 9'),
      );

      expect(outcome).toMatchObject({ agentStatus: 'conflict_reported' });
      expect(harness.calendarClient.callsTo('createEvent')).toBe(0);
      expect(harness.calendarClient.all().map((e) => e.id)).toEqual([
        'existing',
      ]);
      expect(harness.telegram.transcript).toContain('Team standup');
    });

    it('still creates the event when the slot is free', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.classifier.script(createDentist);

      await harness.router.handle(
        routerJob(tenantId, 'book a dentist appointment tomorrow at 9'),
      );

      expect(harness.calendarClient.callsTo('createEvent')).toBe(1);
    });

    /**
     * The safety mechanism. A refactor that quietly turned this into a
     * fire-and-forget delete would destroy real user data, so it is re-run in
     * full rather than trusted.
     */
    it('still blocks a delete until an explicit "yes"', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.calendarClient.seed([
        {
          id: 'evt-dentist',
          title: 'Dentist',
          start: '2026-07-21T09:00:00Z',
          end: '2026-07-21T10:00:00Z',
        },
      ]);
      harness.classifier.script({
        route: 'calendar',
        calendarAction: 'delete_event',
        eventQuery: {
          titleContains: 'Dentist',
          approximateStart: '2026-07-20T00:00:00Z',
          approximateEnd: '2026-07-22T00:00:00Z',
        },
      });

      // Step 1: asked, nothing deleted.
      const asked = await harness.router.handle(
        routerJob(tenantId, 'cancel my dentist appointment'),
      );
      expect(asked).toMatchObject({ agentStatus: 'confirmation_requested' });
      expect(harness.calendarClient.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendarClient.findById('evt-dentist')).toBeDefined();
      expect(harness.telegram.last?.text).toContain('cannot be undone');

      // Step 2: a non-committal reply must not execute it either.
      //
      // Note "ok" would NOT work here — Phase 2 counts it as affirmative, and
      // reading it as assent to "reply yes to confirm" is reasonable. The
      // interesting case is a reply that commits to nothing at all.
      await harness.router.handle(routerJob(tenantId, 'hmm', { messageId: 2 }));
      expect(harness.calendarClient.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendarClient.findById('evt-dentist')).toBeDefined();

      // Step 3: only "yes" executes.
      const confirmed = await harness.router.handle(
        routerJob(tenantId, 'yes', { messageId: 3 }),
      );
      expect(confirmed).toMatchObject({ agentStatus: 'confirmed' });
      expect(harness.calendarClient.findById('evt-dentist')).toBeUndefined();
    });

    it('still declines the delete on "no"', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.calendarClient.seed([
        {
          id: 'evt-keep',
          title: 'Dentist',
          start: '2026-07-21T09:00:00Z',
          end: '2026-07-21T10:00:00Z',
        },
      ]);
      harness.classifier.script({
        route: 'calendar',
        calendarAction: 'delete_event',
        eventQuery: {
          titleContains: 'Dentist',
          approximateStart: '2026-07-20T00:00:00Z',
          approximateEnd: '2026-07-22T00:00:00Z',
        },
      });

      await harness.router.handle(routerJob(tenantId, 'cancel my dentist'));
      await harness.router.handle(routerJob(tenantId, 'no', { messageId: 2 }));

      expect(harness.calendarClient.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendarClient.findById('evt-keep')).toBeDefined();
      expect(await harness.prisma.pendingAction.count()).toBe(0);
    });

    it('still sends the OAuth link when no calendar is connected', async () => {
      harness.classifier.script(createDentist);

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'book a dentist appointment tomorrow at 9'),
      );

      expect(outcome).toMatchObject({ agentStatus: 'needs_connection' });
      expect(harness.telegram.last?.text).toContain('/auth/google?state=');
      expect(harness.calendarClient.calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // RAG (Phase 3)
  // -------------------------------------------------------------------------

  describe('rag', () => {
    it('still writes both tables with correct tenant scoping', async () => {
      harness.classifier.script({
        route: 'rag_ingest',
        contentToStore: 'The API rate limit is 1000 requests per minute.',
      });

      await harness.router.handle(
        routerJob(tenantId, 'save this: the API rate limit is 1000 per minute'),
      );

      const documents = await harness.prisma.document.findMany();
      expect(documents).toHaveLength(1);
      expect(documents[0].userId).toBe(tenantId);

      const chunks = await harness.prisma.documentChunk.findMany();
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.userId).toBe(tenantId);
    });

    /**
     * Tenant isolation, re-run through the router.
     *
     * Deliberately adversarial in the same way as the direct test: both tenants
     * store near-identical text, so a break would produce a confident
     * cross-tenant answer rather than obvious nonsense.
     */
    it('still isolates tenants when the query arrives via the router', async () => {
      const alice = tenantId;
      const bob = await seedRouterTenant(harness, 660_000_002);

      const ALICE = 'Project Nightingale has a budget of 4.2 million dollars.';
      const BOB = 'Project Nightingale has a budget of 9.9 million dollars.';

      harness.embeddings.register(
        'nightingale',
        ALICE,
        BOB,
        'What is the Nightingale budget?',
      );

      await harness.ingestion.ingest(alice, {
        text: ALICE,
        sourceType: 'text',
        sourceName: 'alice-notes.txt',
      });
      await harness.ingestion.ingest(bob, {
        text: BOB,
        sourceType: 'text',
        sourceName: 'bob-notes.txt',
      });

      harness.classifier.script({
        route: 'rag_query',
        question: 'What is the Nightingale budget?',
      });

      await harness.router.handle(
        routerJob(alice, 'what do my notes say about the Nightingale budget?'),
      );

      // The sources handed to the model are where a leak would actually occur.
      const sources = harness.ragLlm.answerCalls[0].sources;
      expect(sources.every((s) => s.sourceName === 'alice-notes.txt')).toBe(
        true,
      );
      expect(sources.some((s) => s.content.includes('9.9 million'))).toBe(
        false,
      );

      // And the citation the user sees names only their own document.
      expect(harness.telegram.transcript).toContain('alice-notes.txt');
      expect(harness.telegram.transcript).not.toContain('bob-notes.txt');
    });

    it('still answers honestly when nothing relevant is stored', async () => {
      harness.embeddings.register('revenue', 'Q4 revenue was 4.2 million.');
      await harness.ingestion.ingest(tenantId, {
        text: 'Q4 revenue was 4.2 million.',
        sourceType: 'pdf',
        sourceName: 'report.pdf',
      });

      harness.classifier.script({
        route: 'rag_query',
        question: 'how do I repair a bicycle chain?',
      });

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'what do my notes say about bicycle repair?'),
      );

      expect(outcome).toMatchObject({ agentStatus: 'nothing_relevant' });
      // Not answered from general knowledge, and not answered at all.
      expect(harness.ragLlm.answerCalls).toEqual([]);
      expect(harness.telegram.transcript).toMatch(
        /couldn't find|rather not guess/,
      );
    });

    it('still ingests an uploaded document through the router', async () => {
      harness.files.register('file-99', 'Meeting notes worth keeping.');

      await harness.router.handle(
        routerJob(tenantId, '', {
          attachment: {
            fileId: 'file-99',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
          },
        }),
      );

      const documents = await harness.prisma.document.findMany();
      expect(documents).toHaveLength(1);
      expect(documents[0].userId).toBe(tenantId);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant routing state (Step 7)
  // -------------------------------------------------------------------------

  it('keeps one tenant’s pending clarification out of another’s message', async () => {
    const other = await seedRouterTenant(harness, 660_000_003);

    harness.classifier.script(
      { route: 'calendar', confidence: 'medium', alternative: 'rag_query' },
      { route: 'rag_ingest', contentToStore: 'something to remember' },
    );

    // Tenant A is left with an unanswered routing question.
    await harness.router.handle(
      routerJob(tenantId, 'remind me about the report'),
    );
    expect(await harness.prisma.pendingClarification.count()).toBe(1);

    // Tenant B's message must be classified normally, not treated as an answer
    // to a question that was never asked of them.
    const outcome = await harness.router.handle(
      routerJob(other, 'save this: something to remember', { messageId: 2 }),
    );

    expect(outcome).toMatchObject({
      status: 'dispatched',
      route: 'rag_ingest',
    });

    const pending = await harness.prisma.pendingClarification.findMany();
    expect(pending).toHaveLength(1);
    expect(pending[0].userId).toBe(tenantId);
  });
});
