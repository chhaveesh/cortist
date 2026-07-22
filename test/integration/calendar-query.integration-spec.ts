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
 * "What's on my calendar?" — the read-only action.
 *
 * This capability did not exist until 2026-07-23, and its absence broke more
 * than the obvious question. The router classified "what's on my calendar
 * tomorrow?" as `unrelated` — correctly, since the agent could create, move,
 * and delete events but never look at them — so the message never reached the
 * calendar agent. That agent is the only thing that sends OAuth links, and the
 * README told new users to send exactly that message to connect. The
 * onboarding path was a dead end.
 *
 * The last test here is the one that matters: an unconnected tenant asking this
 * question must get a link.
 */
describe('Calendar query (integration)', () => {
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

  const queryIntent = (startTime?: string, endTime?: string) => ({
    intent: 'query_events' as const,
    confidence: 'high' as const,
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  });

  it('lists the events in the window it was given', async () => {
    await connectCalendar(harness, tenantId);
    harness.calendar.seed([
      {
        title: 'Dentist',
        start: '2026-07-24T09:00:00Z',
        end: '2026-07-24T10:00:00Z',
      },
      {
        title: 'Lunch with Sam',
        start: '2026-07-24T12:00:00Z',
        end: '2026-07-24T13:00:00Z',
      },
    ]);

    harness.classifier.script(
      queryIntent('2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z'),
    );
    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, "what's on my calendar tomorrow?"),
    );

    expect(outcome).toEqual({ status: 'events_listed', count: 2 });
    expect(harness.telegram.transcript).toContain('Dentist');
    expect(harness.telegram.transcript).toContain('Lunch with Sam');
    // Start AND end: "how long is it for?" should not need a second message.
    // Rendered in the harness zone (Europe/London, BST), so 09:00Z is 10:00.
    expect(harness.telegram.transcript).toMatch(/10:00.11:00/);
  });

  it('says so plainly when the window is empty', async () => {
    await connectCalendar(harness, tenantId);

    harness.classifier.script(
      queryIntent('2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z'),
    );
    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, 'am I free on Friday?'),
    );

    expect(outcome).toEqual({ status: 'events_listed', count: 0 });
    expect(harness.telegram.transcript).toMatch(/nothing on your calendar/i);
  });

  /**
   * The commonest phrasing gives no period at all. Asking "which day did you
   * mean?" for a question that writes nothing would be needless friction, so
   * the agent defaults to the next 24 hours.
   */
  it('defaults the window when the user named no period', async () => {
    await connectCalendar(harness, tenantId);
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    harness.calendar.seed([{ title: 'Standup', start: soon, end: later }]);

    harness.classifier.script(queryIntent());
    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, "what's on my calendar?"),
    );

    expect(outcome).toEqual({ status: 'events_listed', count: 1 });
    expect(harness.telegram.transcript).toContain('Standup');
  });

  /** Nothing is written, so nothing may be created, moved, or deleted. */
  it('changes nothing', async () => {
    await connectCalendar(harness, tenantId);
    harness.calendar.seed([
      {
        title: 'Dentist',
        start: '2026-07-24T09:00:00Z',
        end: '2026-07-24T10:00:00Z',
      },
    ]);
    const before = harness.calendar.all().length;

    harness.classifier.script(
      queryIntent('2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z'),
    );
    await routeToCalendar(
      harness,
      buildJob(tenantId, 'what do I have tomorrow?'),
    );

    expect(harness.calendar.all()).toHaveLength(before);
    // No confirmation prompt either: read-only actions never ask.
    expect(harness.telegram.transcript).not.toMatch(/reply .?yes.?/i);
  });

  /**
   * The regression this whole action exists for.
   *
   * A brand-new user asks the most natural calendar question there is. Before
   * `query_events`, this routed to `unrelated` and they were told the assistant
   * could not help — with no way to discover that connecting a calendar was
   * even possible.
   */
  it('sends an OAuth link when the tenant has no calendar connected', async () => {
    harness.classifier.script(
      queryIntent('2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z'),
    );
    const outcome = await routeToCalendar(
      harness,
      buildJob(tenantId, "what's on my calendar tomorrow?"),
    );

    expect(outcome).toEqual({ status: 'needs_connection' });
    expect(harness.telegram.transcript).toMatch(/auth\/google/);
  });

  /**
   * When Google reports no calendar timezone.
   *
   * Observed on a real account: `events.list` returned no `timeZone`, the
   * client substituted a hardcoded 'UTC', and that guess was cached on the user
   * row permanently. A user in IST then had "add a gym session at 11:30am"
   * placed at 11:30 UTC — 17:00 on their own phone — and because the guess was
   * indistinguishable from a real answer, nothing anywhere said it was a guess.
   *
   * Two rules come out of that: an absent timezone falls back to the
   * *configured* default rather than a hardcoded one, and a fallback is never
   * cached.
   */
  it('falls back to the configured default, and does not cache it', async () => {
    await connectCalendar(harness, tenantId);
    harness.calendar.setTimeZone(undefined as unknown as string);

    harness.classifier.script(queryIntent());
    await routeToCalendar(
      harness,
      buildJob(tenantId, "what's on my calendar?"),
    );

    const user = await harness.prisma.user.findUnique({
      where: { id: tenantId },
    });
    // Still null: a guess must not become the tenant's stored timezone, or the
    // next request inherits it with no way to tell it was never real.
    expect(user?.timeZone).toBeNull();
  });

  it('caches a timezone Google actually reported', async () => {
    await connectCalendar(harness, tenantId);
    harness.calendar.setTimeZone('Asia/Kolkata');

    harness.classifier.script(queryIntent());
    await routeToCalendar(
      harness,
      buildJob(tenantId, "what's on my calendar?"),
    );

    const user = await harness.prisma.user.findUnique({
      where: { id: tenantId },
    });
    expect(user?.timeZone).toBe('Asia/Kolkata');
  });

  /**
   * Searching for a named event, rather than listing a period.
   *
   * "when is chhaveeshs birthday?" used to route correctly to the calendar and
   * then list today's three unrelated events, because query_events had nowhere
   * to put the subject. A confidently wrong answer, from a question the agent
   * understood perfectly.
   */
  describe('searching for a named event', () => {
    it('finds a match far outside the default 24-hour window', async () => {
      await connectCalendar(harness, tenantId);
      const inThreeMonths = new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000,
      ).toISOString();
      harness.calendar.seed([
        {
          title: "Chhaveesh's birthday",
          start: inThreeMonths,
          end: inThreeMonths,
        },
      ]);

      harness.classifier.script({
        intent: 'query_events',
        confidence: 'high',
        searchQuery: 'birthday',
      });
      const outcome = await routeToCalendar(
        harness,
        buildJob(tenantId, "when is chhaveesh's birthday?"),
      );

      expect(outcome).toEqual({ status: 'events_listed', count: 1 });
      expect(harness.telegram.transcript).toMatch(/birthday/i);
    });

    it('says it found nothing rather than listing something else', async () => {
      await connectCalendar(harness, tenantId);
      // Events exist — just not the one asked about. Listing these would be
      // the original bug.
      harness.calendar.seed([
        {
          title: 'coffee',
          start: '2026-07-23T08:30:00Z',
          end: '2026-07-23T09:30:00Z',
        },
      ]);

      harness.classifier.script({
        intent: 'query_events',
        confidence: 'high',
        searchQuery: 'birthday',
      });
      const outcome = await routeToCalendar(
        harness,
        buildJob(tenantId, "when is chhaveesh's birthday?"),
      );

      expect(outcome).toEqual({ status: 'events_listed', count: 0 });
      expect(harness.telegram.last?.text).toMatch(/couldn't find anything/i);
      expect(harness.telegram.transcript).not.toMatch(/coffee/);
    });
  });
});
