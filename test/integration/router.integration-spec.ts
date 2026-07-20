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
 * The router: one classification per message, then dispatch.
 *
 * Dispatch is asserted by observing the agent's *effects* — an event created in
 * the calendar, a document row written — rather than by trusting the router's
 * own return value. A router that decided correctly but wired the call wrongly
 * would pass the weaker test and fail the user.
 */
describe('Intent router (integration)', () => {
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
  // Dispatch
  // -------------------------------------------------------------------------

  it('classifies exactly once per message', async () => {
    // The whole point of the phase: two agents used to classify independently.
    harness.classifier.script({ route: 'unrelated' });

    await harness.router.handle(routerJob(tenantId, 'cancel my meeting'));

    expect(harness.classifier.callCount).toBe(1);
    // And neither agent ran its own classifier.
    expect(harness.ragLlm.classifyCalls).toEqual([]);
  });

  it('dispatches a calendar message into the calendar agent', async () => {
    await connectRouterCalendar(harness, tenantId);
    harness.classifier.script({
      route: 'calendar',
      calendarAction: 'create_event',
      title: 'Dentist',
      startTime: '2026-07-21T09:00:00Z',
      endTime: '2026-07-21T10:00:00Z',
    });

    const outcome = await harness.router.handle(
      routerJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toMatchObject({ status: 'dispatched', route: 'calendar' });

    // Observed through the agent's effect, not the router's claim.
    expect(harness.calendarClient.callsTo('createEvent')).toBe(1);
    expect(harness.calendarClient.all()[0].title).toBe('Dentist');
    // The RAG agent was never involved.
    expect(await harness.prisma.document.count()).toBe(0);
  });

  it('dispatches an ingest message into the RAG agent', async () => {
    harness.classifier.script({
      route: 'rag_ingest',
      contentToStore: 'The API rate limit is 1000 requests per minute.',
    });

    const outcome = await harness.router.handle(
      routerJob(tenantId, 'save this: the API rate limit is 1000 per minute'),
    );

    expect(outcome).toMatchObject({
      status: 'dispatched',
      route: 'rag_ingest',
    });

    const documents = await harness.prisma.document.findMany();
    expect(documents).toHaveLength(1);
    expect(harness.calendarClient.calls).toEqual([]);
  });

  it('dispatches a query message into the RAG agent', async () => {
    harness.embeddings.register(
      'revenue',
      'Q4 revenue was 4.2 million.',
      'what was Q4 revenue?',
    );
    await harness.ingestion.ingest(tenantId, {
      text: 'Q4 revenue was 4.2 million.',
      sourceType: 'pdf',
      sourceName: 'report.pdf',
    });

    harness.classifier.script({
      route: 'rag_query',
      question: 'what was Q4 revenue?',
    });

    const outcome = await harness.router.handle(
      routerJob(tenantId, 'what did the report say about Q4 revenue?'),
    );

    expect(outcome).toMatchObject({ status: 'dispatched', route: 'rag_query' });
    expect(harness.telegram.transcript).toContain('report.pdf');
  });

  it('sends an attachment to RAG without classifying it', async () => {
    harness.files.register('file-1', 'Notes worth remembering.');

    const outcome = await harness.router.handle(
      routerJob(tenantId, '', {
        attachment: {
          fileId: 'file-1',
          fileName: 'notes.txt',
          mimeType: 'text/plain',
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: 'dispatched',
      route: 'rag_ingest',
    });
    // An upload is unambiguous — no LLM call is spent deciding.
    expect(harness.classifier.callCount).toBe(0);
    expect(await harness.prisma.document.count()).toBe(1);
  });

  it('replies politely to an unrelated message and invokes no agent', async () => {
    harness.classifier.script({ route: 'unrelated' });

    const outcome = await harness.router.handle(
      routerJob(tenantId, 'what did you think of the match last night?'),
    );

    expect(outcome).toEqual({ status: 'unrelated' });
    expect(harness.calendarClient.calls).toEqual([]);
    expect(await harness.prisma.document.count()).toBe(0);

    // Scoped honesty: says what it CAN do rather than just failing.
    expect(harness.telegram.last?.text).toMatch(/calendar/i);
    expect(harness.telegram.last?.text).toMatch(/saved|documents/i);
  });

  it('skips chit-chat before spending the LLM call', async () => {
    const outcome = await harness.router.handle(routerJob(tenantId, 'thanks!'));

    expect(outcome).toEqual({ status: 'skipped', reason: 'prefiltered' });
    expect(harness.classifier.callCount).toBe(0);
    expect(harness.telegram.sent).toEqual([]);
  });

  it('passes the tenant’s cached timezone to the classifier', async () => {
    // Read from the users table rather than fetched from Google: the router has
    // no calendar access, and fetching it used to cost an API call per message.
    const other = await seedRouterTenant(
      harness,
      660_000_777,
      'America/New_York',
    );
    harness.classifier.script({ route: 'unrelated' });

    await harness.router.handle(routerJob(other, 'cancel my meeting'));

    expect(harness.classifier.received[0].timeZone).toBe('America/New_York');
  });

  it('falls back to the default timezone for a user who has none', async () => {
    const fresh = await seedRouterTenant(harness, 660_000_888, null);
    harness.classifier.script({ route: 'unrelated' });

    await harness.router.handle(routerJob(fresh, 'cancel my meeting'));

    expect(harness.classifier.received[0].timeZone).toBe('UTC');
  });

  // -------------------------------------------------------------------------
  // Ambiguity and clarification
  // -------------------------------------------------------------------------

  describe('ambiguity', () => {
    const ambiguous = {
      route: 'calendar' as const,
      confidence: 'medium' as const,
      alternative: 'rag_query' as const,
    };

    it('asks instead of guessing, and invokes no agent', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.classifier.script(ambiguous);

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'remind me about the report'),
      );

      expect(outcome).toMatchObject({ status: 'clarification_requested' });

      // The load-bearing assertion: nothing happened yet.
      expect(harness.calendarClient.calls).toEqual([]);
      expect(await harness.prisma.document.count()).toBe(0);

      // The question names both options rather than asking a vague "what?".
      const asked = harness.telegram.last?.text ?? '';
      expect(asked).toMatch(/calendar/i);
      expect(asked).toMatch(/saved documents/i);

      // And it is durable.
      expect(await harness.prisma.pendingClarification.count()).toBe(1);
    });

    it('resolves on the next reply and dispatches to the chosen agent', async () => {
      await connectRouterCalendar(harness, tenantId);
      harness.classifier.script(ambiguous, {
        route: 'calendar',
        calendarAction: 'create_event',
        title: 'Report review',
        startTime: '2026-07-21T09:00:00Z',
        endTime: '2026-07-21T10:00:00Z',
      });

      await harness.router.handle(
        routerJob(tenantId, 'remind me about the report'),
      );

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'the calendar one', { messageId: 2 }),
      );

      expect(outcome).toMatchObject({
        status: 'clarification_resolved',
        route: 'calendar',
      });
      expect(harness.calendarClient.callsTo('createEvent')).toBe(1);
      // Consumed, so a later stray reply cannot re-fire it.
      expect(await harness.prisma.pendingClarification.count()).toBe(0);
    });

    it('re-extracts against the ORIGINAL message, not the one-word reply', async () => {
      // "the calendar one" alone contains nothing to act on. The original text
      // is what gets re-classified.
      await connectRouterCalendar(harness, tenantId);
      harness.classifier.script(ambiguous, { route: 'unrelated' });

      await harness.router.handle(
        routerJob(tenantId, 'remind me about the quarterly report'),
      );
      await harness.router.handle(
        routerJob(tenantId, 'the calendar one', { messageId: 2 }),
      );

      const secondCall = harness.classifier.received[1];
      expect(secondCall.text).toContain('remind me about the quarterly report');
      // The one-word reply alone carries nothing to act on.
      expect(secondCall.text).not.toBe('the calendar one');
    });

    it('gives up after ONE unanswered question rather than looping', async () => {
      // The documented policy: ask once, then admit defeat. A second attempt
      // costs the user a third message and, when the first phrasing did not
      // land, rarely does better. MAX_ATTEMPTS is the single dial.
      harness.classifier.script(ambiguous);

      await harness.router.handle(
        routerJob(tenantId, 'remind me about the report'),
      );
      const outcome = await harness.router.handle(
        routerJob(tenantId, 'hmm', { messageId: 2 }),
      );

      expect(outcome).toEqual({ status: 'gave_up' });
      expect(harness.telegram.last?.text).toMatch(/not sure|rather not guess/i);

      // Cleared, so the next message starts fresh instead of resuming a
      // conversation the user has abandoned.
      expect(await harness.prisma.pendingClarification.count()).toBe(0);
      expect(harness.calendarClient.calls).toEqual([]);
    });

    it('expires an unanswered question instead of resuming it later', async () => {
      harness.classifier.script(ambiguous, { route: 'unrelated' });

      await harness.router.handle(
        routerJob(tenantId, 'remind me about the report'),
      );

      const muchLater = new Date(Date.now() + 3_600_000);
      const outcome = await harness.router.handle(
        routerJob(tenantId, 'the calendar one', { messageId: 2 }),
        muchLater,
      );

      expect(outcome.status).not.toBe('clarification_resolved');
    });
  });

  // -------------------------------------------------------------------------
  // Follow-ups belonging to an agent
  // -------------------------------------------------------------------------

  describe('agent follow-ups', () => {
    async function pendingDelete(): Promise<void> {
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
      await harness.router.handle(
        routerJob(tenantId, 'cancel my dentist appointment'),
      );
    }

    it('routes "yes" to the waiting agent WITHOUT classifying it', async () => {
      // The trap this ordering exists to avoid: "yes" classifies as unrelated,
      // which would strand the pending action and break every confirmation.
      await pendingDelete();
      const callsBefore = harness.classifier.callCount;

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'yes', { messageId: 2 }),
      );

      expect(outcome).toMatchObject({ status: 'follow_up', agent: 'calendar' });
      expect(harness.classifier.callCount).toBe(callsBefore);
      expect(harness.calendarClient.findById('evt-dentist')).toBeUndefined();
    });

    it('routes "no" to the waiting agent and deletes nothing', async () => {
      await pendingDelete();

      await harness.router.handle(routerJob(tenantId, 'no', { messageId: 2 }));

      expect(harness.calendarClient.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendarClient.findById('evt-dentist')).toBeDefined();
    });

    it('lets a genuinely new request supersede a pending confirmation', async () => {
      // Preserved from Phase 2 (§25). An unclear reply that is really a new
      // request must not be answered with "I need a yes or no".
      await pendingDelete();
      harness.classifier.script({
        route: 'rag_ingest',
        contentToStore: 'Remember the wifi code is hunter2.',
      });

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'actually save this: the wifi code is hunter2', {
          messageId: 2,
        }),
      );

      expect(outcome).toMatchObject({ status: 'dispatched' });
      expect(await harness.prisma.document.count()).toBe(1);
      // The confirmation was dropped, and the event was NOT deleted.
      expect(await harness.prisma.pendingAction.count()).toBe(0);
      expect(harness.calendarClient.findById('evt-dentist')).toBeDefined();
    });

    it('re-asks when an unclear reply is not a new request either', async () => {
      await pendingDelete();

      const outcome = await harness.router.handle(
        routerJob(tenantId, 'hmm maybe', { messageId: 2 }),
      );

      expect(outcome).toMatchObject({ status: 'follow_up' });
      expect(harness.telegram.last?.text).toMatch(/yes or no/i);
      // Still pending — the user can still answer.
      expect(await harness.prisma.pendingAction.count()).toBe(1);
    });
  });
});
