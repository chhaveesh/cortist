import { Injectable } from '@nestjs/common';
import { CalendarClient, CalendarEvent } from '../google/calendar.port';

export interface ConflictCheckInput {
  accessToken: string;
  /** ISO-8601 start of the proposed slot. */
  start: string;
  /** ISO-8601 end of the proposed slot. */
  end: string;
  /**
   * Event being moved, if any. Excluded from the results — an event never
   * conflicts with itself, and without this every reschedule would report a
   * false conflict against its own current slot.
   */
  excludeEventId?: string;
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflicts: CalendarEvent[];
  /** Calendar timezone reported by the API, reused by the caller. */
  timeZone: string;
}

@Injectable()
export class ConflictDetectorService {
  constructor(private readonly calendar: CalendarClient) {}

  /**
   * Finds events overlapping a proposed slot.
   *
   * Overlap is half-open: `[start, end)`. Two events that merely touch — one
   * ending exactly as the next begins — do not conflict, which is how back-to-back
   * meetings are normally understood.
   *
   * All-day events are ignored. They span the whole day by definition, so
   * treating them as conflicts would block every booking on a day someone
   * marked "Holiday" or "Birthday".
   */
  async check(input: ConflictCheckInput): Promise<ConflictCheckResult> {
    const proposedStart = new Date(input.start).getTime();
    const proposedEnd = new Date(input.end).getTime();

    const { events, timeZone } = await this.calendar.listEvents(
      input.accessToken,
      { timeMin: input.start, timeMax: input.end },
    );

    const conflicts = events.filter((event) => {
      if (event.allDay) return false;
      if (input.excludeEventId && event.id === input.excludeEventId) {
        return false;
      }

      const eventStart = new Date(event.start).getTime();
      const eventEnd = new Date(event.end).getTime();

      if (Number.isNaN(eventStart) || Number.isNaN(eventEnd)) return false;

      return eventStart < proposedEnd && eventEnd > proposedStart;
    });

    return { hasConflict: conflicts.length > 0, conflicts, timeZone };
  }
}
