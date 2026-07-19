import {
  CalendarHarness,
  buildJob,
  connectCalendar,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  seedTenant,
} from '../calendar-harness';

describe('Calendar connection prompts (integration)', () => {
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
  });

  it('sends an OAuth link when the user has no calendar connected', async () => {
    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toEqual({ status: 'needs_connection' });

    const message = harness.telegram.last?.text ?? '';
    expect(message).toContain('/auth/google?state=');

    // No LLM call and no calendar call — there is nothing to act on yet.
    expect(harness.classifier.callCount).toBe(0);
    expect(harness.calendar.calls).toEqual([]);
  });

  it('issues a link whose state resolves back to this tenant', async () => {
    await harness.agent.handle(buildJob(tenantId, 'cancel my 3pm meeting'));

    const message = harness.telegram.last?.text ?? '';
    const state = decodeURIComponent(/state=([^\s]+)/.exec(message)?.[1] ?? '');

    const payload = harness.oauthState.verify(state);
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.chatId).toBe('900100100');
  });

  it('does not prompt for a non-calendar message', async () => {
    // An unconnected user asking something unrelated should hear nothing —
    // the pre-filter runs before the connection check.
    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'summarise this article for me'),
    );

    expect(outcome).toEqual({ status: 'skipped', reason: 'prefiltered' });
    expect(harness.telegram.sent).toEqual([]);
  });

  it('prompts to reconnect when the refresh token has been revoked', async () => {
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    harness.googleOAuth.failRefresh();

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toEqual({ status: 'needs_connection' });
    expect(harness.telegram.last?.text).toContain('/auth/google?state=');
    expect(harness.calendar.calls).toEqual([]);
  });

  it('proceeds normally once a calendar is connected', async () => {
    await connectCalendar(harness, tenantId);
    harness.classifier.script({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00Z',
      endTime: '2026-07-20T10:00:00Z',
    });

    const outcome = await harness.agent.handle(
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome.status).toBe('event_created');
  });
});
