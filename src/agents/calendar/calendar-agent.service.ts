import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalendarConfigService } from '../../config/calendar-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { zonedOffset, zonedParts } from '../../common/zoned-time';
import { Env } from '../../config/env.schema';
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
  DURATION_OPTIONS,
  interpretDuration,
} from './pending-action/duration-reply';
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
  | { status: 'events_listed'; count: number }
  | { status: 'duration_requested' }
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

/** Window for "what's on my calendar?" when the user named no period. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Window for a search with no period — wide enough for anything annual. */
const YEAR_MS = 365 * DAY_MS;

/**
 * Cap on events listed in one reply. Beyond this the message stops being
 * readable on a phone, and the count of what was omitted is more useful than
 * the omitted entries themselves.
 */
const MAX_LISTED_EVENTS = 10;

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
    config: ConfigService<Env, true>,
  ) {
    this.defaultTimeZone = config.get('DEFAULT_TIMEZONE', { infer: true });
    this.timeZoneOverride = config.get('TIMEZONE_OVERRIDE', { infer: true });
  }

  private readonly defaultTimeZone: string;
  private readonly timeZoneOverride?: string;

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

    // A duration question is not a yes/no question, so it must be read first —
    // "30 minutes" is `unclear` to the confirmation parser, which would send it
    // down the supersede path and lose the half-built event.
    if (pendingAction.type === 'awaiting_duration') {
      return this.handleDurationReply(job, pendingAction, now);
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
        if (!intent.durationGiven) {
          return this.askForDuration(
            job,
            timeZone,
            {
              title: intent.title,
              start: intent.startTime,
              location: intent.location,
              description: intent.description,
            },
            now,
          );
        }

        return this.createEvent(job, accessToken, timeZone, {
          title: intent.title,
          start: intent.startTime,
          end: intent.endTime,
          location: intent.location,
          description: intent.description,
        });

      case 'query_events':
        return this.listEvents(job, accessToken, timeZone, now, intent);

      case 'reschedule_event':
        return this.prepareReschedule(job, accessToken, timeZone, now, intent);

      case 'delete_event':
        return this.prepareDelete(job, accessToken, now, intent.eventQuery);
    }
  }

  // -------------------------------------------------------------------------
  // query — read-only, so no confirmation and no conflict check
  // -------------------------------------------------------------------------

  /**
   * Answers "what's on my calendar?".
   *
   * Read-only, which is why it skips every gate the other actions run through:
   * nothing is created, moved, or destroyed, so there is nothing to confirm and
   * no clash to detect.
   *
   * This action was missing until it was noticed that the README's own
   * onboarding step — "message your bot 'what's on my calendar tomorrow?'" —
   * routed to `unrelated` and never reached this agent, so a new user had no
   * way to trigger the OAuth link at all. The model was right to route it away:
   * the capability genuinely did not exist.
   */
  private async listEvents(
    job: TelegramMessageJob,
    accessToken: string,
    timeZone: string,
    now: Date,
    intent: { startTime?: string; endTime?: string; searchQuery?: string },
  ): Promise<CalendarAgentOutcome> {
    const searching = Boolean(intent.searchQuery);

    // Two different questions, so two different default windows.
    //
    // "What's on my calendar?" means now — the next 24 hours. But "when is
    // Sam's birthday?" is a search, and answering it with today's events (which
    // is what happened before there was a search term at all) is a confidently
    // wrong answer. A year covers anything annual.
    const timeMin = intent.startTime ?? now.toISOString();
    const timeMax =
      intent.endTime ??
      new Date(
        new Date(timeMin).getTime() + (searching ? YEAR_MS : DAY_MS),
      ).toISOString();

    const { events } = await this.calendar.listEvents(accessToken, {
      timeMin,
      timeMax,
      maxResults: MAX_LISTED_EVENTS,
      query: intent.searchQuery,
    });

    if (events.length === 0) {
      await this.telegram.sendMessage(
        job.chatId,
        searching
          ? `I couldn't find anything matching "${intent.searchQuery}" on your calendar in the next year.`
          : `Nothing on your calendar between ${this.formatWhen(timeMin, timeZone)} and ${this.formatWhen(timeMax, timeZone)}.`,
      );
      return { status: 'events_listed', count: 0 };
    }

    // Start AND end, because "how much duration is the gym for?" is a question
    // a listing should already answer. Showing only the start meant the reply
    // was technically about the right event and still useless.
    const lines = events.slice(0, MAX_LISTED_EVENTS).map((event) => {
      const when = event.allDay
        ? `${this.formatWhen(event.start, timeZone)} (all day)`
        : `${this.formatWhen(event.start, timeZone)}–${this.formatTimeOnly(event.end, timeZone)}`;
      return `• ${when} — ${event.title}`;
    });

    // Say so rather than silently truncating: a list that looks complete but
    // is not is worse than a longer message.
    if (events.length > MAX_LISTED_EVENTS) {
      lines.push(`…and ${events.length - MAX_LISTED_EVENTS} more.`);
    }

    await this.telegram.sendMessage(
      job.chatId,
      `📅 ${events.length === 1 ? '1 event' : `${events.length} events`}:\n\n${lines.join('\n')}`,
    );

    return { status: 'events_listed', count: events.length };
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
      newDateGiven?: boolean;
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

    // "Move it to 5pm" means 5pm on the day the event is already on.
    //
    // The classifier cannot do this itself: it never sees the event, so asked
    // for an absolute timestamp it can only anchor to today. In testing that
    // silently proposed moving a Friday appointment to Thursday — caught only
    // because the confirmation names both times. The agent has the event, so
    // the arithmetic belongs here.
    const newStart = intent.newDateGiven
      ? intent.newStartTime
      : rebaseOntoDayOf(target.start, intent.newStartTime, timeZone);

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
      if (pendingAction.type === 'awaiting_duration') {
        // Unreachable: handleFollowUp routes these away above. Kept explicit so
        // the compiler proves it rather than the reader assuming it.
        return { status: 'skipped', reason: 'not_calendar_related' };
      }

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
  // duration — asked for rather than assumed
  // -------------------------------------------------------------------------

  /**
   * Asks how long a new event should be, offering the common answers.
   *
   * The alternative — silently assuming an hour, which is what the prompt used
   * to instruct — invents a commitment length the user never chose and then
   * blocks that slot against everything else. Asking costs one message; a
   * wrong end time costs a conflict that is not real.
   */
  private async askForDuration(
    job: TelegramMessageJob,
    timeZone: string,
    input: {
      title: string;
      start: string;
      location?: string;
      description?: string;
    },
    now: Date,
  ): Promise<CalendarAgentOutcome> {
    await this.pending.set(
      job.tenantId,
      {
        type: 'awaiting_duration',
        title: input.title,
        startTime: input.start,
        timeZone,
        location: input.location,
        description: input.description,
      },
      now,
    );

    await this.telegram.sendMessage(
      job.chatId,
      `How long is "${input.title}" on ${this.formatWhen(input.start, timeZone)}?`,
      { quickReplies: [...DURATION_OPTIONS] },
    );

    return { status: 'duration_requested' };
  }

  /** Turns "30 minutes" into an end time, then creates the event. */
  private async handleDurationReply(
    job: TelegramMessageJob,
    pendingAction: Extract<PendingActionPayload, { type: 'awaiting_duration' }>,
    now: Date,
  ): Promise<CalendarAgentOutcome> {
    const minutes = interpretDuration(job.text);

    if (minutes === null) {
      // Not a duration. Left pending on purpose: the router classifies next,
      // and a genuine new request supersedes this one — the same rule that
      // governs an unclear confirmation (§25).
      return { status: 'unclear_reply' };
    }

    const claimed = await this.pending.claim(job.tenantId, now);
    if (!claimed || claimed.type !== 'awaiting_duration') {
      // Expired, or another message won the race.
      return { status: 'skipped', reason: 'not_calendar_related' };
    }

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

    const end = new Date(
      new Date(claimed.startTime).getTime() + minutes * 60_000,
    ).toISOString();

    try {
      return await this.createEvent(job, accessToken, claimed.timeZone, {
        title: claimed.title,
        start: claimed.startTime,
        end,
        location: claimed.location,
        description: claimed.description,
      });
    } catch (error) {
      if (error instanceof CalendarApiError) {
        return this.handleCalendarError(job, error);
      }
      throw error;
    }
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

    const { events, timeZone: reported } = await this.calendar.listEvents(
      accessToken,
      {
        timeMin,
        timeMax,
        query: query.titleContains?.trim() || undefined,
      },
    );

    // Same rule as resolveTimeZone: the override wins, and an absent timezone
    // is not UTC.
    const timeZone = this.timeZoneOverride ?? reported ?? this.defaultTimeZone;

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
    // Skips the lookup entirely when pinned: no call to make, and nothing
    // Google could say would change the answer.
    if (this.timeZoneOverride) return this.timeZoneOverride;

    const { timeZone } = await this.calendar.listEvents(accessToken, {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 3_600_000).toISOString(),
      maxResults: 1,
    });

    if (!timeZone) {
      // Deliberately NOT cached. Caching a guess is how a user ends up
      // permanently in the wrong zone with no record that it was ever a guess —
      // and the next call might get a real answer.
      this.logger.warn(
        `Google reported no calendar timezone for tenant ${tenantId}; ` +
          `falling back to DEFAULT_TIMEZONE (${this.defaultTimeZone}) for this request only.`,
      );
      return this.defaultTimeZone;
    }

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
  /** Just the clock time, for the end of a range whose day is already shown. */
  private formatTimeOnly(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

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

/**
 * Puts the time-of-day from `time` onto the calendar day of `day`, in the
 * user's timezone.
 *
 * Both instants are interpreted in `timeZone` rather than UTC, because "5pm"
 * means 5pm where the user is. The offset is taken from the target day itself,
 * so a move across a DST boundary lands on the wall-clock time the user asked
 * for rather than an hour either side of it.
 */
export function rebaseOntoDayOf(
  day: string,
  time: string,
  timeZone: string,
): string {
  const dayDate = new Date(day);
  const timeDate = new Date(time);
  if (Number.isNaN(dayDate.getTime()) || Number.isNaN(timeDate.getTime())) {
    return time;
  }

  try {
    const datePart = zonedParts(dayDate, timeZone);
    const timePart = zonedParts(timeDate, timeZone);
    const offset = zonedOffset(dayDate, timeZone);

    return `${datePart.year}-${datePart.month}-${datePart.day}T${timePart.hour}:${timePart.minute}:00${offset}`;
  } catch {
    // An unrecognised IANA zone must not turn a reschedule into an error; the
    // model's own timestamp is a worse answer but still a usable one.
    return time;
  }
}
