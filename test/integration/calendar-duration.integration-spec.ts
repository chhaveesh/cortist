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
 * Asking how long an event should be, instead of assuming an hour.
 *
 * The prompt used to instruct the model to "assume one hour if no duration was
 * given", which invented a commitment length the user never chose and then
 * blocked that slot against everything else — including producing conflicts
 * that were not real. Asking costs one message and a tap.
 */
describe('Calendar duration prompt (integration)', () => {
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

  const createIntent = (durationGiven: boolean) => ({
    intent: 'create_event' as const,
    confidence: 'high' as const,
    title: 'Gym session',
    startTime: '2026-07-24T11:30:00Z',
    endTime: '2026-07-24T12:30:00Z',
    durationGiven,
  });

  it('asks, and offers the common answers, when no duration was given', async () => {
    harness.classifier.script(createIntent(false));

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    expect(outcome).toEqual({ status: 'duration_requested' });
    expect(harness.telegram.last?.text).toMatch(/how long/i);
    // Tappable, so the common case costs a tap rather than typing.
    expect(harness.telegram.last?.quickReplies).toEqual([
      '30 minutes',
      '1 hour',
      '2 hours',
    ]);
  });

  /** Nothing may be written until the user has answered. */
  it('creates nothing while it is waiting', async () => {
    harness.classifier.script(createIntent(false));

    await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    expect(harness.calendar.all()).toHaveLength(0);
  });

  it('creates the event once the duration arrives', async () => {
    harness.classifier.script(createIntent(false));
    await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, '30 minutes', { messageId: 2 }),
    );

    expect(outcome).toMatchObject({ status: 'event_created' });
    const [event] = harness.calendar.all();
    expect(event.title).toBe('Gym session');
    expect(event.start).toBe('2026-07-24T11:30:00Z');
    // 30 minutes after the start, not the hour the model guessed.
    expect(new Date(event.end).toISOString()).toBe('2026-07-24T12:00:00.000Z');
  });

  it('honours a typed answer the buttons never offered', async () => {
    harness.classifier.script(createIntent(false));
    await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    await routeToCalendar(
      harness,
      buildJob(tenantId, '45 mins', { messageId: 2 }),
    );

    const [event] = harness.calendar.all();
    expect(new Date(event.end).toISOString()).toBe('2026-07-24T12:15:00.000Z');
  });

  /**
   * The point of the whole feature: a duration the user actually stated must
   * never trigger the question.
   */
  it('does not ask when the user already said how long', async () => {
    harness.classifier.script(createIntent(true));

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow for an hour'),
    );

    expect(outcome).toMatchObject({ status: 'event_created' });
    expect(harness.telegram.transcript).not.toMatch(/how long/i);
  });

  /**
   * The answer still goes through the conflict check. Skipping it here would
   * make the duration prompt a way to book over an existing event.
   */
  it('still refuses a clash discovered after the answer', async () => {
    harness.calendar.seed([
      {
        title: 'Meeting',
        start: '2026-07-24T11:00:00Z',
        end: '2026-07-24T12:00:00Z',
      },
    ]);
    harness.classifier.script(createIntent(false));
    await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, '30 minutes', { messageId: 2 }),
    );

    expect(outcome).toMatchObject({ status: 'conflict_reported' });
    // Only the seeded meeting: nothing was booked over it.
    expect(harness.calendar.all()).toHaveLength(1);
  });

  /**
   * A reply that is not a duration is left pending rather than answered, so the
   * router can decide whether the user changed their mind — the same rule that
   * governs an unclear confirmation (§25).
   */
  it('leaves the question standing for a reply that is not a duration', async () => {
    harness.classifier.script(createIntent(false));
    await routeToCalendar(
      harness,
      buildJob(tenantId, 'add a gym session at 11:30 tomorrow'),
    );

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'actually never mind', { messageId: 2 }),
    );

    expect(outcome).toEqual({ status: 'unclear_reply' });
    expect(harness.calendar.all()).toHaveLength(0);
    expect(await harness.pending.get(tenantId)).not.toBeNull();
  });
});
