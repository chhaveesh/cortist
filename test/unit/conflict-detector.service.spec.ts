import { ConflictDetectorService } from '../../src/agents/calendar/conflict/conflict-detector.service';
import { FakeCalendarClient } from '../fakes/fake-calendar.client';

const TOKEN = 'access-token';

describe('ConflictDetectorService', () => {
  let calendar: FakeCalendarClient;
  let detector: ConflictDetectorService;

  beforeEach(() => {
    calendar = new FakeCalendarClient('Europe/London');
    detector = new ConflictDetectorService(calendar);
  });

  const check = (start: string, end: string, excludeEventId?: string) =>
    detector.check({ accessToken: TOKEN, start, end, excludeEventId });

  it('reports no conflict against an empty calendar', async () => {
    const result = await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z');

    expect(result.hasConflict).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.timeZone).toBe('Europe/London');
  });

  it('detects a straightforward overlap', async () => {
    calendar.seed([
      {
        id: 'existing',
        title: 'Standup',
        start: '2026-07-20T09:30:00Z',
        end: '2026-07-20T10:30:00Z',
      },
    ]);

    const result = await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z');

    expect(result.hasConflict).toBe(true);
    expect(result.conflicts.map((event) => event.id)).toEqual(['existing']);
  });

  it.each([
    [
      'proposed fully inside existing',
      '2026-07-20T09:15:00Z',
      '2026-07-20T09:45:00Z',
    ],
    [
      'existing fully inside proposed',
      '2026-07-20T08:00:00Z',
      '2026-07-20T12:00:00Z',
    ],
    ['overlapping the start', '2026-07-20T08:30:00Z', '2026-07-20T09:30:00Z'],
    ['overlapping the end', '2026-07-20T09:30:00Z', '2026-07-20T11:00:00Z'],
    ['exactly coincident', '2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'],
  ])('detects overlap when %s', async (_name, start, end) => {
    calendar.seed([
      {
        id: 'existing',
        title: 'Existing',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);

    expect((await check(start, end)).hasConflict).toBe(true);
  });

  /**
   * Half-open intervals: back-to-back meetings are how calendars normally work,
   * and reporting them as clashes would make the agent unusable for anyone with
   * a full day.
   */
  it.each([
    [
      'ending exactly when the existing one starts',
      '2026-07-20T08:00:00Z',
      '2026-07-20T09:00:00Z',
    ],
    [
      'starting exactly when the existing one ends',
      '2026-07-20T10:00:00Z',
      '2026-07-20T11:00:00Z',
    ],
  ])(
    'treats touching boundaries as no conflict (%s)',
    async (_name, start, end) => {
      calendar.seed([
        {
          id: 'existing',
          title: 'Existing',
          start: '2026-07-20T09:00:00Z',
          end: '2026-07-20T10:00:00Z',
        },
      ]);

      expect((await check(start, end)).hasConflict).toBe(false);
    },
  );

  it('ignores all-day events', async () => {
    // An all-day "Holiday" spans the whole day; treating it as a conflict would
    // block every booking on that date.
    calendar.seed([
      {
        id: 'holiday',
        title: 'Public Holiday',
        start: '2026-07-20T00:00:00Z',
        end: '2026-07-21T00:00:00Z',
        allDay: true,
      },
    ]);

    expect(
      (await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z')).hasConflict,
    ).toBe(false);
  });

  it('excludes the event being rescheduled', async () => {
    calendar.seed([
      {
        id: 'moving',
        title: 'The event being moved',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);

    // Without the exclusion an event would always conflict with its own slot,
    // making every same-window reschedule impossible.
    expect(
      (await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z', 'moving'))
        .hasConflict,
    ).toBe(false);

    expect(
      (await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z')).hasConflict,
    ).toBe(true);
  });

  it('reports every overlapping event, not just the first', async () => {
    calendar.seed([
      {
        id: 'a',
        title: 'A',
        start: '2026-07-20T09:00:00Z',
        end: '2026-07-20T09:30:00Z',
      },
      {
        id: 'b',
        title: 'B',
        start: '2026-07-20T09:30:00Z',
        end: '2026-07-20T10:00:00Z',
      },
    ]);

    const result = await check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z');

    expect(result.conflicts.map((event) => event.id).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('ignores events with unparseable timestamps rather than throwing', async () => {
    calendar.seed([
      { id: 'broken', title: 'Broken', start: 'not-a-date', end: 'also-not' },
    ]);

    await expect(
      check('2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z'),
    ).resolves.toMatchObject({ hasConflict: false });
  });
});
