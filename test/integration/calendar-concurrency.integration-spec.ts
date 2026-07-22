import {
  CalendarHarness,
  buildJob,
  connectCalendar,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  routeToCalendar,
  seedTenant,
} from '../calendar-harness';

/**
 * Concurrency on a single tenant.
 *
 * Phase 1's dedupe stops the *same* message being processed twice. These cover
 * what it does not: several *different* messages from one user arriving at once,
 * and whether that can double-book a slot or corrupt the pending-action state
 * that guards destructive operations.
 */
describe('Concurrent calendar requests for one tenant (integration)', () => {
  let harness: CalendarHarness;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createCalendarHarness();
  });

  afterAll(async () => {
    await destroyCalendarHarness(harness);
  });

  beforeEach(async () => {
    await resetCalendarState(harness);
    tenantId = await seedTenant(harness);
    await connectCalendar(harness, tenantId);
  });

  const createIntent = (title: string, start: string, end: string) => ({
    intent: 'create_event' as const,
    confidence: 'high' as const,
    title,
    startTime: start,
    endTime: end,
    durationGiven: true,
  });

  it('creates distinct events for distinct non-overlapping requests', async () => {
    harness.classifier.script(
      createIntent('Morning', '2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'),
      createIntent('Midday', '2026-07-20T12:00:00Z', '2026-07-20T13:00:00Z'),
      createIntent('Evening', '2026-07-20T18:00:00Z', '2026-07-20T19:00:00Z'),
    );

    const outcomes = await Promise.all([
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book morning', { messageId: 1 }),
      ),
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book midday', { messageId: 2 }),
      ),
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book evening', { messageId: 3 }),
      ),
    ]);

    expect(outcomes.every((o) => o.status === 'event_created')).toBe(true);
    expect(harness.calendar.all()).toHaveLength(3);
  });

  it('serialises same-slot creates under ordinary interleaving', async () => {
    // The realistic case: the first create lands before the second conflict
    // check runs, so the clash is caught and only one event exists.
    const slot = ['2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'] as const;
    harness.classifier.script(
      createIntent('Dentist', ...slot),
      createIntent('Dentist', ...slot),
    );

    const outcomes = await Promise.all([
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book dentist', { messageId: 1 }),
      ),
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book dentist', { messageId: 2 }),
      ),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'event_created'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'conflict_reported'),
    ).toHaveLength(1);
    expect(harness.calendar.all()).toHaveLength(1);
  });

  /**
   * DOCUMENTED GAP — a real check-then-act race, demonstrated deterministically.
   *
   * Conflict detection reads the calendar and then writes, with no lock between
   * them. If two creates for the same slot both get past their read before
   * either write lands, both succeed and the slot is double-booked.
   *
   * The test above does NOT prove this is safe — it passes only because the
   * interleaving happened to serialise. Here the write is held open so both
   * reads are forced to run first, which is the honest way to show whether the
   * race exists rather than hoping a scheduler reveals it.
   *
   * How exposed is it in practice? Limited but not zero: Phase 1 dedupes
   * identical messages, and a single user's jobs usually run one at a time.
   * But `WORKER_CONCURRENCY` is 5 by default and nothing pins one tenant to one
   * worker, so two quick messages from the same user genuinely can overlap.
   *
   * The fix is a per-tenant advisory lock (`pg_advisory_xact_lock` on a hash of
   * the tenant id) around read-then-write, or a uniqueness constraint on the
   * slot. Deferred to Phase 3 and recorded in DECISIONS.md §33 — deliberately
   * not silently accepted.
   */
  it('DOCUMENTED GAP: same-slot creates double-book when both reads precede both writes', async () => {
    const slot = ['2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'] as const;
    harness.classifier.script(
      createIntent('Dentist', ...slot),
      createIntent('Dentist', ...slot),
    );

    // Hold every write until both conflict checks have completed.
    harness.calendar.blockCreates();

    const inFlight = Promise.all([
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book dentist', { messageId: 1 }),
      ),
      routeToCalendar(
        harness,
        buildJob(tenantId, 'book dentist', { messageId: 2 }),
      ),
    ]);

    await waitForCreateAttempts(2);
    harness.calendar.releaseCreates();

    const outcomes = await inFlight;

    // Both saw a free slot, so both wrote. This is the bug, pinned.
    expect(
      outcomes.filter((outcome) => outcome.status === 'event_created'),
    ).toHaveLength(2);
    expect(harness.calendar.all()).toHaveLength(2);
  });

  /** Waits until `n` create attempts have been recorded by the fake. */
  async function waitForCreateAttempts(n: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (harness.calendar.callsTo('createEvent') < n) {
      if (Date.now() > deadline) {
        throw new Error(
          `Only ${harness.calendar.callsTo('createEvent')} of ${n} creates were attempted`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('leaves exactly one pending action after concurrent destructive requests', async () => {
    // The unique constraint on user_id is what makes this safe: two concurrent
    // confirmation prompts cannot both be outstanding, so a later "yes" is
    // never ambiguous about which event it refers to.
    harness.calendar.seed([
      {
        id: 'evt-a',
        title: 'Alpha',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
      {
        id: 'evt-b',
        title: 'Beta',
        start: '2026-07-20T14:00:00Z',
        end: '2026-07-20T15:00:00Z',
      },
    ]);

    const deleteIntent = (titleContains: string) => ({
      intent: 'delete_event' as const,
      confidence: 'high' as const,
      eventQuery: {
        titleContains,
        approximateStart: '2026-07-19T00:00:00Z',
        approximateEnd: '2026-07-21T00:00:00Z',
      },
    });

    harness.classifier.script(deleteIntent('Alpha'), deleteIntent('Beta'));

    await Promise.all([
      routeToCalendar(
        harness,
        buildJob(tenantId, 'cancel alpha', { messageId: 1 }),
      ),
      routeToCalendar(
        harness,
        buildJob(tenantId, 'cancel beta', { messageId: 2 }),
      ),
    ]);

    const pending = await harness.prisma.pendingAction.findMany({
      where: { userId: tenantId },
    });
    expect(pending).toHaveLength(1);

    // Critically, neither event was deleted — both are still awaiting a "yes".
    expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
    expect(harness.calendar.all()).toHaveLength(2);
  });

  it('executes a confirmed action at most once under a repeated "yes"', async () => {
    // A retried job or an impatient user double-tapping must not delete twice.
    harness.calendar.seed([
      {
        id: 'evt-once',
        title: 'Dentist',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);

    harness.classifier.script({
      intent: 'delete_event',
      confidence: 'high',
      eventQuery: {
        titleContains: 'Dentist',
        approximateStart: '2026-07-19T00:00:00Z',
        approximateEnd: '2026-07-21T00:00:00Z',
      },
    });

    await routeToCalendar(harness, buildJob(tenantId, 'cancel my dentist'));

    const outcomes = await Promise.all([
      routeToCalendar(harness, buildJob(tenantId, 'yes', { messageId: 2 })),
      routeToCalendar(harness, buildJob(tenantId, 'yes', { messageId: 3 })),
    ]);

    // The pending row is cleared before execution, so at most one "yes" can
    // find work to do.
    const confirmed = outcomes.filter((o) => o.status === 'confirmed');
    expect(confirmed.length).toBeLessThanOrEqual(1);
    expect(harness.calendar.callsTo('deleteEvent')).toBeLessThanOrEqual(1);
    expect(harness.calendar.findById('evt-once')).toBeUndefined();
    expect(await harness.prisma.pendingAction.count()).toBe(0);
  });
});
