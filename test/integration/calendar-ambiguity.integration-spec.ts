import {
  CalendarHarness,
  buildJob,
  connectCalendar,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  seedTenant,
} from '../calendar-harness';

/**
 * Resolving "reschedule my call" when the user has several calls.
 *
 * This is the reason the model emits an eventQuery rather than an event id:
 * we resolve against the real calendar and can tell the difference between
 * one match, none, and several — instead of the model picking one at random.
 */
describe('Ambiguous event resolution (integration)', () => {
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

  const deleteQuery = (titleContains: string) => ({
    intent: 'delete_event' as const,
    confidence: 'high' as const,
    eventQuery: {
      titleContains,
      approximateStart: '2026-07-19T00:00:00Z',
      approximateEnd: '2026-07-22T00:00:00Z',
    },
  });

  it('says so when nothing matches', async () => {
    harness.classifier.script(deleteQuery('dentist'));

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'cancel my dentist appointment'),
    );

    expect(outcome).toEqual({ status: 'event_not_found' });
    expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
    expect(harness.telegram.last?.text).toContain("couldn't find");

    // Nothing is left pending — there is nothing to confirm.
    expect(await harness.prisma.pendingAction.count()).toBe(0);
  });

  it('lists the candidates and takes no action when several match', async () => {
    harness.calendar.seed([
      {
        id: 'call-1',
        title: 'Call with Priya',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T09:30:00Z',
      },
      {
        id: 'call-2',
        title: 'Call with Sam',
        start: '2026-07-20T14:00:00Z',
        end: '2026-07-20T14:30:00Z',
      },
      {
        id: 'call-3',
        title: 'Call with the bank',
        start: '2026-07-20T16:00:00Z',
        end: '2026-07-20T16:30:00Z',
      },
    ]);
    harness.classifier.script(deleteQuery('Call'));

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'cancel my call'),
    );

    expect(outcome).toEqual({ status: 'ambiguous_event', candidates: 3 });
    expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
    expect(await harness.prisma.pendingAction.count()).toBe(0);

    // Every candidate is named, so the user can actually choose.
    const message = harness.telegram.last?.text ?? '';
    expect(message).toContain('Call with Priya');
    expect(message).toContain('Call with Sam');
    expect(message).toContain('Call with the bank');
  });

  it('proceeds to confirmation when exactly one matches', async () => {
    harness.calendar.seed([
      {
        id: 'call-1',
        title: 'Call with Priya',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T09:30:00Z',
      },
      {
        id: 'lunch',
        title: 'Lunch',
        start: '2026-07-20T12:00:00Z',
        end: '2026-07-20T13:00:00Z',
      },
    ]);
    harness.classifier.script(deleteQuery('Call'));

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'cancel my call with Priya'),
    );

    expect(outcome).toEqual({
      status: 'confirmation_requested',
      actionType: 'delete_event',
    });
    expect(harness.telegram.last?.text).toContain('Call with Priya');
  });

  it('does not offer all-day events as candidates', async () => {
    // An all-day "Conference" is not what someone means by "cancel my meeting".
    harness.calendar.seed([
      {
        id: 'all-day',
        title: 'Meeting-free day',
        start: '2026-07-20T00:00:00Z',
        end: '2026-07-21T00:00:00Z',
        allDay: true,
      },
      {
        id: 'real',
        title: 'Meeting with Ops',
        start: '2026-07-20T11:00:00Z',
        end: '2026-07-20T12:00:00Z',
      },
    ]);
    harness.classifier.script(deleteQuery('Meeting'));

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'cancel my meeting'),
    );

    expect(outcome).toEqual({
      status: 'confirmation_requested',
      actionType: 'delete_event',
    });
    expect(harness.telegram.last?.text).toContain('Meeting with Ops');
  });

  it('handles the event vanishing between confirmation and execution', async () => {
    harness.calendar.seed([
      {
        id: 'evt-1',
        title: 'Dentist',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);
    harness.classifier.script(deleteQuery('Dentist'));

    await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

    // Someone deletes it from Google's UI while we wait for the reply.
    harness.calendar.failNextWith('not_found');

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'yes', { messageId: 2 }),
    );

    expect(outcome.status).toBe('error');
    expect(harness.telegram.transcript).toContain('no longer exists');
  });
});
