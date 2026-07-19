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
 * The confirmation gate.
 *
 * The load-bearing assertion throughout is the negative one: after the prompt
 * is sent, *nothing has happened yet*. A test that only checked the happy path
 * would pass even if the agent deleted first and asked afterwards.
 */
describe('Confirmation before destructive actions (integration)', () => {
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

    harness.calendar.seed([
      {
        id: 'evt-dentist',
        title: 'Dentist',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);
  });

  const deleteIntent = {
    intent: 'delete_event' as const,
    confidence: 'high' as const,
    eventQuery: {
      titleContains: 'Dentist',
      approximateStart: '2026-07-19T00:00:00Z',
      approximateEnd: '2026-07-21T00:00:00Z',
    },
  };

  const rescheduleIntent = {
    intent: 'reschedule_event' as const,
    confidence: 'high' as const,
    eventQuery: deleteIntent.eventQuery,
    newStartTime: '2026-07-20T14:00:00Z',
  };

  describe('delete', () => {
    it('asks first and deletes nothing', async () => {
      harness.classifier.script(deleteIntent);

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'cancel my dentist appointment'),
      );

      expect(outcome).toEqual({
        status: 'confirmation_requested',
        actionType: 'delete_event',
      });

      // Nothing deleted.
      expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendar.findById('evt-dentist')).toBeDefined();

      // Prompt names the event and warns it is irreversible.
      expect(harness.telegram.last?.text).toContain('Dentist');
      expect(harness.telegram.last?.text).toContain('cannot be undone');

      // And the pending action is durable.
      const row = await harness.prisma.pendingAction.findUniqueOrThrow({
        where: { userId: tenantId },
      });
      expect(row.actionType).toBe('delete_event');
    });

    it('deletes only after an affirmative reply', async () => {
      harness.classifier.script(deleteIntent);
      await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'yes', { messageId: 2 }),
      );

      expect(outcome).toEqual({
        status: 'confirmed',
        actionType: 'delete_event',
      });
      expect(harness.calendar.findById('evt-dentist')).toBeUndefined();
      expect(harness.telegram.transcript).toContain('Deleted');

      // Pending action consumed, so a stray later "yes" cannot re-fire it.
      expect(
        await harness.prisma.pendingAction.count({
          where: { userId: tenantId },
        }),
      ).toBe(0);
    });

    it('does not delete on a negative reply', async () => {
      harness.classifier.script(deleteIntent);
      await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'no', { messageId: 2 }),
      );

      expect(outcome).toEqual({ status: 'declined' });
      expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendar.findById('evt-dentist')).toBeDefined();
      expect(
        await harness.prisma.pendingAction.count({
          where: { userId: tenantId },
        }),
      ).toBe(0);
    });

    it('keeps waiting on an unclear reply', async () => {
      harness.classifier.script(deleteIntent);
      await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'hmm maybe', { messageId: 2 }),
      );

      expect(outcome.status).toBe('clarification_requested');
      expect(harness.calendar.callsTo('deleteEvent')).toBe(0);

      // Still pending — the user can still say yes.
      expect(
        await harness.prisma.pendingAction.count({
          where: { userId: tenantId },
        }),
      ).toBe(1);
    });

    it('never classifies the confirmation reply as a new request', async () => {
      // "yes" on its own would classify as not_calendar_related and strand the
      // pending action. The pending check must run before classification.
      harness.classifier.script(deleteIntent);
      await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

      const callsBefore = harness.classifier.callCount;
      await harness.agent.handle(buildJob(tenantId, 'yes', { messageId: 2 }));

      expect(harness.classifier.callCount).toBe(callsBefore);
    });

    it('ignores an expired pending action', async () => {
      harness.classifier.script(deleteIntent);
      await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));

      // "yes" arriving after the TTL must not execute anything.
      const wellAfterExpiry = new Date(Date.now() + 3_600_000);
      harness.classifier.script({
        intent: 'not_calendar_related',
        confidence: 'high',
      });

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'yes', { messageId: 2 }),
        wellAfterExpiry,
      );

      expect(outcome.status).not.toBe('confirmed');
      expect(harness.calendar.callsTo('deleteEvent')).toBe(0);
      expect(harness.calendar.findById('evt-dentist')).toBeDefined();
    });
  });

  describe('reschedule', () => {
    it('asks first and moves nothing', async () => {
      harness.classifier.script(rescheduleIntent);

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'move my dentist appointment to 2pm'),
      );

      expect(outcome).toEqual({
        status: 'confirmation_requested',
        actionType: 'reschedule_event',
      });
      expect(harness.calendar.callsTo('updateEvent')).toBe(0);
      expect(harness.calendar.findById('evt-dentist')?.start).toBe(
        '2026-07-20T09:00:00Z',
      );
    });

    it('moves the event after an affirmative reply, preserving its duration', async () => {
      harness.classifier.script(rescheduleIntent);
      await harness.agent.handle(buildJob(tenantId, 'move my dentist to 2pm'));

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'yes please', { messageId: 2 }),
      );

      expect(outcome).toEqual({
        status: 'confirmed',
        actionType: 'reschedule_event',
      });

      const moved = harness.calendar.findById('evt-dentist');
      expect(moved?.start).toBe('2026-07-20T14:00:00Z');
      // Original was one hour; no new end was given, so one hour is preserved.
      expect(moved?.end).toBe('2026-07-20T15:00:00.000Z');
    });

    it('reports a clash at the new time without asking for confirmation', async () => {
      harness.calendar.seed([
        {
          id: 'evt-blocker',
          title: 'Board meeting',
          start: '2026-07-20T14:30:00Z',
          end: '2026-07-20T15:30:00Z',
        },
      ]);
      harness.classifier.script(rescheduleIntent);

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'move my dentist to 2pm'),
      );

      expect(outcome).toEqual({ status: 'conflict_reported', conflicts: 1 });
      expect(harness.telegram.transcript).toContain('Board meeting');

      // No confirmation was requested, so nothing is pending.
      expect(await harness.prisma.pendingAction.count()).toBe(0);
      expect(harness.calendar.callsTo('updateEvent')).toBe(0);
    });

    it('does not treat the event as conflicting with its own current slot', async () => {
      // Moving 09:00–10:00 to 09:30 overlaps its own old slot; excluding the
      // event itself is what makes small nudges possible at all.
      harness.classifier.script({
        ...rescheduleIntent,
        newStartTime: '2026-07-20T09:30:00Z',
      });

      const outcome = await harness.agent.handle(
        buildJob(tenantId, 'push my dentist back half an hour'),
      );

      expect(outcome.status).toBe('confirmation_requested');
    });
  });

  it('a new request supersedes an unanswered one', async () => {
    harness.calendar.seed([
      {
        id: 'evt-lunch',
        title: 'Lunch',
        start: '2026-07-20T12:00:00Z',
        end: '2026-07-20T13:00:00Z',
      },
    ]);

    harness.classifier.script(deleteIntent, {
      ...deleteIntent,
      eventQuery: { ...deleteIntent.eventQuery, titleContains: 'Lunch' },
    });

    await harness.agent.handle(buildJob(tenantId, 'cancel my dentist'));
    await harness.agent.handle(
      buildJob(tenantId, 'actually cancel my lunch instead', { messageId: 2 }),
    );

    // "yes" now refers to the most recent question — lunch, not dentist.
    await harness.agent.handle(buildJob(tenantId, 'yes', { messageId: 3 }));

    expect(harness.calendar.findById('evt-lunch')).toBeUndefined();
    expect(harness.calendar.findById('evt-dentist')).toBeDefined();
  });
});
