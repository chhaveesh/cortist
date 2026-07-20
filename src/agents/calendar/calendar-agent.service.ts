import { Injectable, Logger } from '@nestjs/common';
import { CalendarConfigService } from '../../config/calendar-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramMessageJob } from '../../common/contracts/telegram-message.job';
import {
  MissingOAuthConnectionError,
  OAuthReauthorizationRequiredError,
  OAuthTokenService,
} from '../../oauth/oauth-token.service';
import { OAuthStateService } from '../../oauth/oauth-state.service';
import { TelegramSenderService } from '../../telegram/outbound/telegram-sender.service';
import { ConflictDetectorService } from './conflict/conflict-detector.service';
import {
  CalendarApiError,
  CalendarClient,
  CalendarEvent,
} from './google/calendar.port';
import { CalendarIntent, EventQuery } from './intent/calendar-intent.schema';
import { interpretConfirmation } from './pending-action/confirmation-reply';
import {
  PendingActionPayload,
  PendingActionService,
} from './pending-action/pending-action.service';

/**
 * What the agent did with a message. Returned rather than logged-and-forgotten
 * so the worker and the tests can both assert on the outcome.
 */
export type CalendarAgentOutcome =
  | { status: 'not_configured'; missing: string[] }
  | { status: 'skipped'; reason: 'not_calendar_related' | 'prefiltered' }
  | { status: 'needs_connection' }
  | { status: 'clarification_requested' }
  | { status: 'event_created'; eventId: string }
  | { status: 'conflict_reported'; conflicts: number }
  | {
      status: 'confirmation_requested';
      actionType: PendingActionPayload['type'];
    }
  | { status: 'confirmed'; actionType: PendingActionPayload['type'] }
  | { status: 'declined' }
  | { status: 'unclear_reply' }
  | { status: 'event_not_found' }
  | { status: 'ambiguous_event'; candidates: number }
  | { status: 'error'; message: string };

/** Assumed slot length when a reschedule gives a new start but no new end. */
const DEFAULT_EVENT_MINUTES = 60;

/** How far around an event query to search when the model gave no window. */
const DEFAULT_SEARCH_WINDOW_DAYS = 30;

/**
 * The calendar agent.
 *
 * Single public entry point (`handle`), so the general router in a later phase
 * can call this exactly as it will call every other agent.
 *
 * Ordering inside `handle` is load-bearing and worth reading carefully — a
 * pending confirmation is checked BEFORE classification, because "yes" on its
 * own classifies as not-calendar-related and would otherwise strand the
 * pending action forever.
 */
@Injectable()
export class CalendarAgentService {
  private readonly logger = new Logger(CalendarAgentService.name);

  constructor(
    private readonly calendarConfig: CalendarConfigService,
    private readonly calendar: CalendarClient,
    private readonly conflicts: ConflictDetectorService,
    private readonly pending: PendingActionService,
    private readonly tokens: OAuthTokenService,
    private readonly oauthState: OAuthStateService,
    private readonly telegram: TelegramSenderService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * True when this agent is waiting on the tenant's next message.
   *
   * The router asks this BEFORE classifying, because a reply like "yes"
   * classifies as unrelated and would otherwise strand the pending action —
   * silently breaking every delete and reschedule confirmation.
   */
  async claimsFollowUp(tenantId: string, now = new Date()): Promise<boolean> {
    return (await this.pending.get(tenantId, now)) !== null;
  }

  /**
   * Handles a reply to an outstanding confirmation.
   *
   * Only called when `claimsFollowUp` returned true, so a pending action is
   * expected — but it is re-read rather than assumed, since it can expire
   * between the two calls.
   */
  async handleFollowUp(
    job: TelegramMessageJob,
    now = new Date(),
  ): Promise<CalendarAgentOutcome> {
    const pendingAction = await this.pending.get(job.tenantId, now);
    if (!pendingAction) {
      return { status: 'skipped', reason: 'not_calendar_related' };
    }

    const reply = interpretConfirmation(job.text);

    if (reply !== 'unclear') {
      return this.handleConfirmationReply(job, pendingAction, reply);
    }

    // Neither yes nor no — it is either a garbled answer or the user changing
    // their mind ("actually, cancel my lunch instead").
    //
    // Deliberately returns WITHOUT messaging the user. Telling those two apart
    // needs a classification, and since Phase 4a that belongs to the router.
    // Replying here would mean the user gets "I need a yes or no" even when
    // they had clearly moved on — the exact behaviour §25 established should
    // not happen.
    return { status: 'unclear_reply' };
  }

  /** Drops a pending action the router has decided is superseded. */
  async cancelPendingAction(tenantId: string): Promise<void> {
    await this.pending.clear(tenantId);
  }

  /** The re-ask, sent by the router once it knows this was not a new request. */
  async askForClearConfirmation(job: TelegramMessageJob): Promise<void> {
    await this.telegram.sendMessage(
      job.chatId,
      'Sorry, I need a clear yes or no first — reply "yes" to go ahead, or "no" to cancel.',
    );
  }

  /**
   * Acts on a message the router has already classified as calendar work.
   *
   * The agent no longer decides whether a message is its business, and no
   * longer classifies: `intent` arrives pre-extracted from the router's single
   * classification. What stays here is everything that needs calendar context —
   * credentials, connection state, conflict detection, and confirmation.
   */
  async handle(
    job: TelegramMessageJob,
    intent: CalendarIntent,
    now = new Date(),
  ): Promise<CalendarAgentOutcome> {
    if (!this.calendarConfig.isConfigured) {
      const missing = this.calendarConfig.missingVars;
      this.logger.error(
        `Cannot handle a calendar request for tenant ${job.tenantId} — missing config: ${missing.join(', ')}`,
      );
      await this.telegram
        .sendMessage(
          job.chatId,
          "I can't reach your calendar — my calendar integration isn't " +
            'configured yet. This is a setup problem on my side, not something ' +
            'you did.',
        )
        .catch(() => undefined);
      return { status: 'not_configured', missing };
    }

    if (!(await this.tokens.hasConnection(job.tenantId))) {
      await this.sendConnectPrompt(job);
      return { status: 'needs_connection' };
    }

    let accessToken: string;
    try {
      accessToken = await this.tokens.getAccessToken(
        job.tenantId,
        undefined,
        now,
      );
    } catch (error) {
      if (
        error instanceof MissingOAuthConnectionError ||
        error instanceof OAuthReauthorizationRequiredError
      ) {
        await this.sendConnectPrompt(job);
        return { status: 'needs_connection' };
      }
      throw error;
    }

    try {
      // The timezone is still read from the calendar here — the router used the
      // cached value for extraction, and this refreshes the cache as a side
      // effect of work we were doing anyway.
      const timeZone = await this.resolveTimeZone(
        accessToken,
        now,
        job.tenantId,
      );
      return await this.dispatch(job, intent, accessToken, timeZone, now);
    } catch (error) {
      if (error instanceof CalendarApiError) {
        return this.handleCalendarError(job, error);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Intent routing
  // -------------------------------------------------------------------------

  private async dispatch(
    job: TelegramMessageJob,
    intent: CalendarIntent,
    accessToken: string,
    timeZone: string,
    now: Date,
  ): Promise<CalendarAgentOutcome> {
    switch (intent.intent) {
      case 'not_calendar_related':
        return { status: 'skipped', reason: 'not_calendar_related' };

      case 'needs_clarification':
        await this.telegram.sendMessage(job.chatId, intent.question);
        return { status: 'clarification_requested' };

      case 'create_event':
        return this.createEvent(job, accessToken, timeZone, {
          title: intent.title,
          start: intent.startTime,
          end: intent.endTime,
          location: intent.location,
          description: intent.description,
        });

      case 'reschedule_event':
        return this.prepareReschedule(job, accessToken, timeZone, now, intent);

      case 'delete_event':
        return this.prepareDelete(job, accessToken, now, intent.eventQuery);
    }
  }

  // -------------------------------------------------------------------------
  // create — executes directly, after a conflict check
  // -------------------------------------------------------------------------

  /**
   * Creating runs without confirmation. It is additive, conflict-checked, and
   * trivially undone — unlike delete (destroys data) or reschedule (moves a
   * commitment other people may have planned around). The summary we send back
   * makes a mistake visible immediately.
   */
  private async createEvent(
    job: TelegramMessageJob,
    accessToken: string,
    timeZone: string,
    input: {
      title: string;
      start: string;
      end: string;
      location?: string;
      description?: string;
    },
  ): Promise<CalendarAgentOutcome> {
    const check = await this.conflicts.check({
      accessToken,
      start: input.start,
      end: input.end,
    });

    if (check.hasConflict) {
      await this.telegram.sendMessage(
        job.chatId,
        this.describeConflict(
          input.title,
          input.start,
          check.conflicts,
          timeZone,
        ),
      );
      return { status: 'conflict_reported', conflicts: check.conflicts.length };
    }

    const event = await this.calendar.createEvent(accessToken, {
      title: input.title,
      start: input.start,
      end: input.end,
      timeZone,
      location: input.location,
      description: input.description,
    });

    await this.telegram.sendMessage(
      job.chatId,
      `✅ Created "${event.title}" for ${this.formatWhen(event.start, timeZone)}.`,
    );

    return { status: 'event_created', eventId: event.id };
  }

  // -------------------------------------------------------------------------
  // reschedule / delete — resolve, then ask for confirmation
  // -------------------------------------------------------------------------

  private async prepareReschedule(
    job: TelegramMessageJob,
    accessToken: string,
    timeZone: string,
    now: Date,
    intent: {
      eventQuery: EventQuery;
      newStartTime: string;
      newEndTime?: string;
    },
  ): Promise<CalendarAgentOutcome> {
    const resolution = await this.resolveEvent(
      accessToken,
      intent.eventQuery,
      now,
    );
    if (resolution.outcome) {
      await this.telegram.sendMessage(job.chatId, resolution.message);
      return resolution.outcome;
    }

    const target = resolution.event;
    const newStart = intent.newStartTime;
    const newEnd = intent.newEndTime ?? this.preserveDuration(target, newStart);

    // Exclude the event being moved, or it would conflict with its own old slot.
    const check = await this.conflicts.check({
      accessToken,
      start: newStart,
      end: newEnd,
      excludeEventId: target.id,
    });

    if (check.hasConflict) {
      await this.telegram.sendMessage(
        job.chatId,
        this.describeConflict(
          target.title,
          newStart,
          check.conflicts,
          timeZone,
        ),
      );
      return { status: 'conflict_reported', conflicts: check.conflicts.length };
    }

    await this.pending.set(
      job.tenantId,
      {
        type: 'reschedule_event',
        eventId: target.id,
        eventTitle: target.title,
        originalStart: target.start,
        newStart,
        newEnd,
        timeZone,
      },
      now,
    );

    await this.telegram.sendMessage(
      job.chatId,
      `Move "${target.title}" from ${this.formatWhen(target.start, timeZone)} ` +
        `to ${this.formatWhen(newStart, timeZone)}?\n\nReply "yes" to confirm.`,
    );

    return { status: 'confirmation_requested', actionType: 'reschedule_event' };
  }

  private async prepareDelete(
    job: TelegramMessageJob,
    accessToken: string,
    now: Date,
    query: EventQuery,
  ): Promise<CalendarAgentOutcome> {
    const resolution = await this.resolveEvent(accessToken, query, now);
    if (resolution.outcome) {
      await this.telegram.sendMessage(job.chatId, resolution.message);
      return resolution.outcome;
    }

    const target = resolution.event;
    const timeZone = resolution.timeZone;

    await this.pending.set(
      job.tenantId,
      {
        type: 'delete_event',
        eventId: target.id,
        eventTitle: target.title,
        eventStart: target.start,
      },
      now,
    );

    await this.telegram.sendMessage(
      job.chatId,
      `Delete "${target.title}" on ${this.formatWhen(target.start, timeZone)}?\n\n` +
        'This cannot be undone. Reply "yes" to confirm.',
    );

    return { status: 'confirmation_requested', actionType: 'delete_event' };
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  /**
   * Executes or declines a pending action. Only ever called with a decisive
   * reply — `unclear` is resolved by `handleUnclearReply`.
   */
  private async handleConfirmationReply(
    job: TelegramMessageJob,
    pending: PendingActionPayload,
    reply: 'affirmative' | 'negative',
  ): Promise<CalendarAgentOutcome> {
    let pendingAction = pending;
    if (reply === 'negative') {
      await this.pending.clear(job.tenantId);
      await this.telegram.sendMessage(job.chatId, 'OK — nothing changed.');
      return { status: 'declined' };
    }

    // Claim atomically rather than clearing: `get()` then `clear()` is a
    // check-then-act race, and two concurrent "yes" replies both passed it and
    // both executed the delete. `claim()` uses DELETE … RETURNING, so exactly
    // one caller wins. Losing the race means someone else already handled it.
    const claimed = await this.pending.claim(job.tenantId);
    if (!claimed) {
      this.logger.debug(
        `Confirmation for ${job.tenantId} lost the claim — already handled`,
      );
      return { status: 'declined' };
    }
    pendingAction = claimed;

    let accessToken: string;
    try {
      accessToken = await this.tokens.getAccessToken(job.tenantId);
    } catch (error) {
      if (
        error instanceof MissingOAuthConnectionError ||
        error instanceof OAuthReauthorizationRequiredError
      ) {
        await this.sendConnectPrompt(job);
        return { status: 'needs_connection' };
      }
      throw error;
    }

    try {
      if (pendingAction.type === 'delete_event') {
        await this.calendar.deleteEvent(accessToken, pendingAction.eventId);
        await this.telegram.sendMessage(
          job.chatId,
          `🗑️ Deleted "${pendingAction.eventTitle}".`,
        );
      } else {
        await this.calendar.updateEvent(accessToken, {
          eventId: pendingAction.eventId,
          start: pendingAction.newStart,
          end: pendingAction.newEnd,
          timeZone: pendingAction.timeZone,
        });
        await this.telegram.sendMessage(
          job.chatId,
          `✅ Moved "${pendingAction.eventTitle}" to ` +
            `${this.formatWhen(pendingAction.newStart, pendingAction.timeZone)}.`,
        );
      }
    } catch (error) {
      if (error instanceof CalendarApiError) {
        return this.handleCalendarError(job, error);
      }
      throw error;
    }

    return { status: 'confirmed', actionType: pendingAction.type };
  }

  // -------------------------------------------------------------------------
  // Event resolution
  // -------------------------------------------------------------------------

  /**
   * Turns the model's description of an event into exactly one real event.
   *
   * Three outcomes matter: none found, one found (proceed), or several found —
   * in which case we list them and ask, rather than picking. That last case is
   * the whole reason the model emits a query instead of an id.
   */
  private async resolveEvent(
    accessToken: string,
    query: EventQuery,
    now: Date,
  ): Promise<
    | {
        outcome: CalendarAgentOutcome;
        message: string;
        event?: never;
        timeZone?: never;
      }
    | {
        outcome?: never;
        message?: never;
        event: CalendarEvent;
        timeZone: string;
      }
  > {
    const timeMin = query.approximateStart?.trim()
      ? query.approximateStart
      : now.toISOString();
    const timeMax = query.approximateEnd?.trim()
      ? query.approximateEnd
      : new Date(
          now.getTime() + DEFAULT_SEARCH_WINDOW_DAYS * 86_400_000,
        ).toISOString();

    const { events, timeZone } = await this.calendar.listEvents(accessToken, {
      timeMin,
      timeMax,
      query: query.titleContains?.trim() || undefined,
    });

    const candidates = events.filter((event) => !event.allDay);

    if (candidates.length === 0) {
      return {
        outcome: { status: 'event_not_found' },
        message: query.titleContains?.trim()
          ? `I couldn't find an event matching "${query.titleContains}".`
          : "I couldn't find a matching event.",
      };
    }

    if (candidates.length > 1) {
      const listed = candidates
        .slice(0, 5)
        .map(
          (event, index) =>
            `${index + 1}. ${event.title} — ${this.formatWhen(event.start, timeZone)}`,
        )
        .join('\n');

      return {
        outcome: { status: 'ambiguous_event', candidates: candidates.length },
        message: `I found ${candidates.length} matching events:\n${listed}\n\nWhich one did you mean?`,
      };
    }

    return { event: candidates[0], timeZone };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * The calendar's timezone, refreshed into the users table as a side effect.
   *
   * The router reads the cached value to resolve relative times during
   * extraction, so keeping it current matters — but it is written here, on a
   * call we were making anyway, rather than costing a request of its own.
   */
  private async resolveTimeZone(
    accessToken: string,
    now: Date,
    tenantId: string,
  ): Promise<string> {
    // A one-hour lookahead is the cheapest call that still returns the
    // calendar's timeZone field.
    const { timeZone } = await this.calendar.listEvents(accessToken, {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 3_600_000).toISOString(),
      maxResults: 1,
    });

    // Best effort: a failed cache write must not fail the user's request.
    await this.prisma.user
      .update({ where: { id: tenantId }, data: { timeZone } })
      .catch(() => undefined);

    return timeZone;
  }

  private preserveDuration(event: CalendarEvent, newStart: string): string {
    const originalMs =
      new Date(event.end).getTime() - new Date(event.start).getTime();
    const durationMs =
      Number.isFinite(originalMs) && originalMs > 0
        ? originalMs
        : DEFAULT_EVENT_MINUTES * 60_000;

    return new Date(new Date(newStart).getTime() + durationMs).toISOString();
  }

  private async sendConnectPrompt(job: TelegramMessageJob): Promise<void> {
    const state = this.oauthState.issue(job.tenantId, job.chatId);
    const url = this.tokens.buildConnectUrl(state);

    await this.telegram.sendMessage(
      job.chatId,
      'I need access to your Google Calendar first.\n\n' +
        `Connect it here: ${url}\n\n` +
        'The link expires shortly — ask again if it does.',
    );
  }

  private describeConflict(
    title: string,
    start: string,
    conflicts: CalendarEvent[],
    timeZone: string,
  ): string {
    const listed = conflicts
      .slice(0, 5)
      .map(
        (event) =>
          `• ${event.title} (${this.formatWhen(event.start, timeZone)})`,
      )
      .join('\n');

    return (
      `⚠️ "${title}" at ${this.formatWhen(start, timeZone)} clashes with:\n${listed}\n\n` +
      "I haven't changed anything. Want a different time?"
    );
  }

  private handleCalendarError(
    job: TelegramMessageJob,
    error: CalendarApiError,
  ): CalendarAgentOutcome {
    // Deliberately not awaited into the return path — the user-facing message
    // is best-effort; the outcome is what the worker acts on.
    const message =
      error.kind === 'rate_limited'
        ? 'Google Calendar is rate-limiting me right now. Try again in a moment.'
        : error.kind === 'not_found'
          ? 'That event no longer exists — someone may have already removed it.'
          : error.kind === 'unauthorized'
            ? 'My access to your calendar was revoked. Send me a calendar message to reconnect.'
            : 'Something went wrong talking to Google Calendar. Nothing was changed.';

    void this.telegram.sendMessage(job.chatId, message).catch(() => undefined);

    this.logger.warn(
      `Calendar error for tenant ${job.tenantId} (${error.kind}): ${error.message}`,
    );

    // Rate limits are transient — rethrow so BullMQ retries under the Phase 1
    // backoff policy. Everything else is terminal for this message.
    if (error.kind === 'rate_limited') {
      throw error;
    }

    return { status: 'error', message: error.message };
  }

  /** Human-readable time in the user's own timezone. */
  private formatWhen(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
      }).format(date);
    } catch {
      // An unrecognised IANA zone must not break the reply.
      return date.toISOString();
    }
  }
}
