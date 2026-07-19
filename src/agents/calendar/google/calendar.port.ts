/**
 * The Calendar API seam.
 *
 * Everything the agent knows about Google Calendar goes through this interface,
 * which is what makes "no real Google calls in CI" a structural property rather
 * than a testing convention: the fake and the real client are interchangeable,
 * and the agent cannot reach the network except through here.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO-8601 with offset. */
  start: string;
  end: string;
  /** True for all-day events, which have date-only boundaries. */
  allDay?: boolean;
  location?: string;
  description?: string;
  htmlLink?: string;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  description?: string;
}

export interface UpdateEventInput {
  eventId: string;
  start: string;
  end: string;
  timeZone: string;
}

export interface ListEventsInput {
  /** Inclusive lower bound, ISO-8601. */
  timeMin: string;
  /** Exclusive upper bound, ISO-8601. */
  timeMax: string;
  maxResults?: number;
  /** Free-text search across event fields, used to resolve an eventQuery. */
  query?: string;
}

export interface ListEventsResult {
  events: CalendarEvent[];
  /**
   * The calendar's own timezone, as reported by the list response. This is how
   * relative times ("tomorrow at 3") get resolved without requesting the extra
   * `calendar.settings.readonly` scope.
   */
  timeZone: string;
}

/** Categorised Calendar API failure, so callers can react rather than guess. */
export type CalendarErrorKind =
  | 'unauthorized' // 401 — token rejected; re-auth required
  | 'not_found' // 404 — the event is already gone
  | 'rate_limited' // 429 / 403 rateLimitExceeded — retry later
  | 'unknown';

export class CalendarApiError extends Error {
  readonly name = 'CalendarApiError';

  constructor(
    message: string,
    readonly kind: CalendarErrorKind,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

/**
 * Implemented by GoogleCalendarClient in production and by FakeCalendarClient
 * in tests. Every method receives an already-valid access token — refresh is
 * OAuthTokenService's job, not this layer's.
 */
export abstract class CalendarClient {
  abstract listEvents(
    accessToken: string,
    input: ListEventsInput,
  ): Promise<ListEventsResult>;

  abstract createEvent(
    accessToken: string,
    input: CreateEventInput,
  ): Promise<CalendarEvent>;

  abstract updateEvent(
    accessToken: string,
    input: UpdateEventInput,
  ): Promise<CalendarEvent>;

  abstract deleteEvent(accessToken: string, eventId: string): Promise<void>;
}
