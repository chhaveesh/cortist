import {
  CalendarApiError,
  CalendarClient,
  CalendarErrorKind,
  CalendarEvent,
  CreateEventInput,
  ListEventsInput,
  ListEventsResult,
  UpdateEventInput,
} from '../../src/agents/calendar/google/calendar.port';

/**
 * In-memory Calendar API.
 *
 * This is the reason no automated test can reach Google: it is bound to the
 * `CalendarClient` token, so the agent's only route to a calendar is this
 * object. A real network call would require deliberately overriding the
 * provider back to GoogleCalendarClient.
 *
 * It models the behaviour the agent actually depends on — window filtering,
 * free-text search, and error classification — rather than mirroring Google's
 * full API surface.
 */
export class FakeCalendarClient extends CalendarClient {
  private events: CalendarEvent[] = [];
  private nextId = 1;
  private failures: Array<{ kind: CalendarErrorKind; message: string }> = [];

  /** Calls recorded in order, for asserting that nothing ran when it shouldn't. */
  readonly calls: Array<{ method: string; args: unknown }> = [];

  constructor(private timeZone = 'Europe/London') {
    super();
  }

  // --- test controls ------------------------------------------------------

  seed(
    events: Array<Partial<CalendarEvent> & { start: string; end: string }>,
  ): void {
    for (const event of events) {
      this.events.push({
        id: event.id ?? `evt-${this.nextId++}`,
        title: event.title ?? 'Untitled',
        start: event.start,
        end: event.end,
        allDay: event.allDay ?? false,
        location: event.location,
        description: event.description,
      });
    }
  }

  /** Make the next call fail with a specific error kind. */
  failNextWith(kind: CalendarErrorKind, message = `simulated ${kind}`): void {
    this.failures.push({ kind, message });
  }

  setTimeZone(timeZone: string): void {
    this.timeZone = timeZone;
  }

  all(): CalendarEvent[] {
    return [...this.events];
  }

  findById(id: string): CalendarEvent | undefined {
    return this.events.find((event) => event.id === id);
  }

  callsTo(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  reset(): void {
    this.events = [];
    this.failures = [];
    this.calls.length = 0;
    this.nextId = 1;
  }

  // --- CalendarClient -----------------------------------------------------

  async listEvents(
    _accessToken: string,
    input: ListEventsInput,
  ): Promise<ListEventsResult> {
    this.record('listEvents', input);

    const min = new Date(input.timeMin).getTime();
    const max = new Date(input.timeMax).getTime();
    const needle = input.query?.toLowerCase().trim();

    const matches = this.events
      .filter((event) => {
        const start = new Date(event.start).getTime();
        const end = new Date(event.end).getTime();
        // Overlap with the window, matching Google's timeMin/timeMax semantics.
        return start < max && end > min;
      })
      .filter((event) =>
        needle ? event.title.toLowerCase().includes(needle) : true,
      )
      .slice(0, input.maxResults ?? 50);

    return { events: matches, timeZone: this.timeZone };
  }

  async createEvent(
    _accessToken: string,
    input: CreateEventInput,
  ): Promise<CalendarEvent> {
    this.record('createEvent', input);

    const event: CalendarEvent = {
      id: `evt-${this.nextId++}`,
      title: input.title,
      start: input.start,
      end: input.end,
      allDay: false,
      location: input.location,
      description: input.description,
    };

    this.events.push(event);
    return event;
  }

  async updateEvent(
    _accessToken: string,
    input: UpdateEventInput,
  ): Promise<CalendarEvent> {
    this.record('updateEvent', input);

    const event = this.events.find(
      (candidate) => candidate.id === input.eventId,
    );
    if (!event) {
      throw new CalendarApiError('Event not found', 'not_found', 404);
    }

    event.start = input.start;
    event.end = input.end;
    return event;
  }

  async deleteEvent(_accessToken: string, eventId: string): Promise<void> {
    this.record('deleteEvent', { eventId });

    const index = this.events.findIndex((event) => event.id === eventId);
    if (index === -1) {
      throw new CalendarApiError('Event not found', 'not_found', 404);
    }

    this.events.splice(index, 1);
  }

  /**
   * Records the call and applies any queued failure. Queued failures are
   * consumed here — before the operation runs — so a simulated error leaves
   * state untouched, exactly as a real failed API call would.
   */
  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });

    const failure = this.failures.shift();
    if (failure) {
      throw new CalendarApiError(failure.message, failure.kind);
    }
  }
}
