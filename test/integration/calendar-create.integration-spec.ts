import {
  CalendarHarness,
  buildJob,
  connectCalendar,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  seedTenant,
} from '../calendar-harness';

describe('Calendar create + conflict detection (integration)', () => {
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

  const createIntent = (
    start = '2026-07-20T09:00:00Z',
    end = '2026-07-20T10:00:00Z',
  ) => ({
    intent: 'create_event' as const,
    confidence: 'high' as const,
    title: 'Dentist',
    startTime: start,
    endTime: end,
  });

  it('creates the event when the slot is free, and confirms it', async () => {
    harness.classifier.script(createIntent());

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome.status).toBe('event_created');

    const created = harness.calendar.all();
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Dentist');
    expect(created[0].start).toBe('2026-07-20T09:00:00Z');

    expect(harness.telegram.transcript).toContain('Dentist');
    expect(harness.telegram.sent).toHaveLength(1);
  });

  it('does NOT create the event when the slot clashes, and says what clashes', async () => {
    harness.calendar.seed([
      {
        id: 'existing',
        title: 'Team standup',
        start: '2026-07-20T09:30:00Z',
        end: '2026-07-20T10:30:00Z',
      },
    ]);
    harness.classifier.script(createIntent());

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toEqual({ status: 'conflict_reported', conflicts: 1 });

    // The critical assertion: nothing was written to the calendar.
    expect(harness.calendar.callsTo('createEvent')).toBe(0);
    expect(harness.calendar.all().map((event) => event.id)).toEqual([
      'existing',
    ]);

    // And the user was told what it clashed with, not just "no".
    expect(harness.telegram.transcript).toContain('Team standup');
  });

  it('creates back-to-back with an existing event without reporting a clash', async () => {
    harness.calendar.seed([
      {
        id: 'earlier',
        title: 'Earlier meeting',
        start: '2026-07-20T08:00:00Z',
        end: '2026-07-20T09:00:00Z',
      },
    ]);
    harness.classifier.script(createIntent());

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome.status).toBe('event_created');
  });

  it('passes the calendar timezone and current time to the classifier', async () => {
    // These two inputs are what let the model resolve "tomorrow at 3pm"
    // correctly; if they stop being passed, the failure is silent and subtle.
    harness.calendar.setTimeZone('America/New_York');
    harness.classifier.script(createIntent());

    const before = new Date();
    await harness.agent.handle(buildJob(tenantId, 'dentist tomorrow at 9'));

    expect(harness.classifier.received).toHaveLength(1);
    expect(harness.classifier.received[0].timeZone).toBe('America/New_York');
    expect(harness.classifier.received[0].now.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(harness.classifier.received[0].text).toBe('dentist tomorrow at 9');
  });

  it('asks a clarifying question instead of guessing', async () => {
    harness.classifier.script({
      intent: 'needs_clarification',
      confidence: 'medium',
      question: 'What time should the dentist appointment be?',
    });

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book me a dentist appointment'),
    );

    expect(outcome.status).toBe('clarification_requested');
    expect(harness.calendar.callsTo('createEvent')).toBe(0);
    expect(harness.telegram.last?.text).toBe(
      'What time should the dentist appointment be?',
    );
  });

  it('skips a message the classifier deems non-calendar', async () => {
    harness.classifier.script({
      intent: 'not_calendar_related',
      confidence: 'high',
    });

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'am I free to ask you something?'),
    );

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'not_calendar_related',
    });
    expect(harness.telegram.sent).toEqual([]);
  });

  it('skips without an LLM call when the pre-filter finds nothing calendar-ish', async () => {
    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'write me a python script to parse csv'),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'prefiltered' });
    expect(harness.classifier.callCount).toBe(0);
    expect(harness.telegram.sent).toEqual([]);
  });

  it('reports a rate limit as retryable by rethrowing', async () => {
    // Rate limits are transient, so the job should go back through BullMQ's
    // backoff rather than being swallowed.
    harness.classifier.script(createIntent());
    harness.calendar.failNextWith('rate_limited');

    await expect(
      harness.agent.handle(buildJob(tenantId, 'dentist tomorrow at 9')),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
