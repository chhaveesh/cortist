import { CalendarConfigService } from '../../src/config/calendar-config.service';
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
    harness.classifier.script({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00Z',
      endTime: '2026-07-20T10:00:00Z',
      durationGiven: true,
    });
    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toEqual({ status: 'needs_connection' });

    const message = harness.telegram.last?.text ?? '';
    expect(message).toContain('/auth/google?state=');

    // No calendar call — there is nothing to act on until they connect.
    expect(harness.calendar.calls).toEqual([]);
  });

  it('issues a link whose state resolves back to this tenant', async () => {
    harness.classifier.script({
      intent: 'delete_event',
      confidence: 'high',
      eventQuery: {
        titleContains: 'meeting',
        approximateStart: '',
        approximateEnd: '',
      },
    });
    await routeToCalendar(harness, buildJob(tenantId, 'cancel my 3pm meeting'));

    const message = harness.telegram.last?.text ?? '';
    const state = decodeURIComponent(/state=([^\s]+)/.exec(message)?.[1] ?? '');

    const payload = harness.oauthState.verify(state);
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.chatId).toBe('900100100');
  });

  it('prompts to reconnect when the refresh token has been revoked', async () => {
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    harness.googleOAuth.failRefresh();
    harness.classifier.script({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00Z',
      endTime: '2026-07-20T10:00:00Z',
      durationGiven: true,
    });

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome).toEqual({ status: 'needs_connection' });
    expect(harness.telegram.last?.text).toContain('/auth/google?state=');
    expect(harness.calendar.calls).toEqual([]);
  });

  /**
   * Degraded mode. Requiring these credentials once crash-looped the gateway,
   * taking the Telegram webhook down and losing messages over a calendar key
   * the ingestion path never touches.
   */
  describe('when the calendar integration is not configured', () => {
    let calendarConfig: CalendarConfigService;

    beforeEach(() => {
      calendarConfig = harness.app.get(CalendarConfigService);
      jest.spyOn(calendarConfig, 'isConfigured', 'get').mockReturnValue(false);
      jest
        .spyOn(calendarConfig, 'missingVars', 'get')
        .mockReturnValue(['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY']);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('tells the user plainly and touches nothing external', async () => {
      harness.classifier.script({
        intent: 'create_event',
        confidence: 'high',
        title: 'Dentist',
        startTime: '2026-07-20T09:00:00Z',
        endTime: '2026-07-20T10:00:00Z',
        durationGiven: true,
      });
      const outcome = await routeToCalendar(
        harness,
        buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
      );

      expect(outcome).toEqual({
        status: 'not_configured',
        missing: ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY'],
      });

      // No calendar call, and no OAuth link that could not work anyway.
      expect(harness.calendar.calls).toEqual([]);

      // The user hears something honest rather than silence.
      const message = harness.telegram.last?.text ?? '';
      expect(message).toContain("isn't");
      expect(message).not.toContain('/auth/google');
    });
  });

  it('proceeds normally once a calendar is connected', async () => {
    await connectCalendar(harness, tenantId);
    harness.classifier.script({
      intent: 'create_event',
      confidence: 'high',
      title: 'Dentist',
      startTime: '2026-07-20T09:00:00Z',
      endTime: '2026-07-20T10:00:00Z',
      durationGiven: true,
    });

    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'book a dentist appointment tomorrow at 9'),
    );

    expect(outcome.status).toBe('event_created');
  });
});
