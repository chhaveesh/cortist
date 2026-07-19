import { Injectable, Logger } from '@nestjs/common';
import { calendar_v3, google } from 'googleapis';
import {
  CalendarApiError,
  CalendarClient,
  CalendarErrorKind,
  CalendarEvent,
  CreateEventInput,
  ListEventsInput,
  ListEventsResult,
  UpdateEventInput,
} from './calendar.port';

const PRIMARY_CALENDAR = 'primary';

/**
 * Real Calendar API v3 implementation.
 *
 * This class is never exercised in the automated suite — tests bind
 * FakeCalendarClient to the CalendarClient token instead. Its correctness is
 * verified by the manual walkthrough documented in the README.
 */
@Injectable()
export class GoogleCalendarClient extends CalendarClient {
  private readonly logger = new Logger(GoogleCalendarClient.name);

  /**
   * Built per call from the caller's access token. Constructed via
   * `google.auth.OAuth2` rather than a direct google-auth-library import:
   * `googleapis` nests its own copy of that package, and mixing the two yields
   * structurally incompatible client types.
   */
  private api(accessToken: string): calendar_v3.Calendar {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.calendar({ version: 'v3', auth });
  }

  async listEvents(
    accessToken: string,
    input: ListEventsInput,
  ): Promise<ListEventsResult> {
    return this.call('listEvents', async () => {
      const response = await this.api(accessToken).events.list({
        calendarId: PRIMARY_CALENDAR,
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        maxResults: input.maxResults ?? 50,
        q: input.query,
        singleEvents: true, // expand recurring events into instances
        orderBy: 'startTime',
      });

      return {
        events: (response.data.items ?? []).map((item) => this.toEvent(item)),
        // The list response carries the calendar's timezone — this is why the
        // agent can resolve "tomorrow at 3pm" without an extra OAuth scope.
        timeZone: response.data.timeZone ?? 'UTC',
      };
    });
  }

  async createEvent(
    accessToken: string,
    input: CreateEventInput,
  ): Promise<CalendarEvent> {
    return this.call('createEvent', async () => {
      const response = await this.api(accessToken).events.insert({
        calendarId: PRIMARY_CALENDAR,
        requestBody: {
          summary: input.title,
          location: input.location,
          description: input.description,
          start: { dateTime: input.start, timeZone: input.timeZone },
          end: { dateTime: input.end, timeZone: input.timeZone },
        },
      });

      return this.toEvent(response.data);
    });
  }

  async updateEvent(
    accessToken: string,
    input: UpdateEventInput,
  ): Promise<CalendarEvent> {
    return this.call('updateEvent', async () => {
      // PATCH, not PUT: a full update would blank out every field we did not
      // send (attendees, description, reminders).
      const response = await this.api(accessToken).events.patch({
        calendarId: PRIMARY_CALENDAR,
        eventId: input.eventId,
        requestBody: {
          start: { dateTime: input.start, timeZone: input.timeZone },
          end: { dateTime: input.end, timeZone: input.timeZone },
        },
      });

      return this.toEvent(response.data);
    });
  }

  async deleteEvent(accessToken: string, eventId: string): Promise<void> {
    await this.call('deleteEvent', async () => {
      await this.api(accessToken).events.delete({
        calendarId: PRIMARY_CALENDAR,
        eventId,
      });
      return undefined;
    });
  }

  private toEvent(item: calendar_v3.Schema$Event): CalendarEvent {
    const allDay = Boolean(item.start?.date);

    return {
      id: item.id ?? '',
      title: item.summary ?? '(untitled)',
      // All-day events carry `date`; timed events carry `dateTime`.
      start: item.start?.dateTime ?? item.start?.date ?? '',
      end: item.end?.dateTime ?? item.end?.date ?? '',
      allDay,
      location: item.location ?? undefined,
      description: item.description ?? undefined,
      htmlLink: item.htmlLink ?? undefined,
    };
  }

  /**
   * Translates Google's error shapes into the port's CalendarApiError, so
   * callers branch on `kind` rather than sniffing status codes and message
   * strings from a third-party library.
   */
  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const status = this.statusOf(error);
      const kind = this.classify(status);
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Calendar ${operation} failed (${kind}): ${message}`);
      throw new CalendarApiError(message, kind, status);
    }
  }

  private statusOf(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const candidate = error as { code?: unknown; status?: unknown };
    if (typeof candidate.code === 'number') return candidate.code;
    if (typeof candidate.status === 'number') return candidate.status;
    return undefined;
  }

  private classify(status: number | undefined): CalendarErrorKind {
    switch (status) {
      case 401:
        return 'unauthorized';
      case 404:
        return 'not_found';
      case 403: // Google returns 403 for rateLimitExceeded as well as denials
      case 429:
        return 'rate_limited';
      default:
        return 'unknown';
    }
  }
}
