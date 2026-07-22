import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalendarAgentService } from '../agents/calendar/calendar-agent.service';
import { RagAgentService } from '../agents/rag/rag-agent.service';
import {
  TelegramMessageJob,
  attachmentOf,
} from '../common/contracts/telegram-message.job';
import { Env } from '../config/env.schema';
import { LlmConfigService } from '../config/llm-config.service';
import { LlmRequestError, RETRY_WINDOW_SECONDS } from '../llm/llm-error';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramSenderService } from '../telegram/outbound/telegram-sender.service';
import { interpretClarification } from './clarification/clarification-reply';
import { PendingClarificationService } from './clarification/pending-clarification.service';
import { RouteClassifier } from './intent/route-classifier.service';
import {
  RouteName,
  RoutingDecision,
  describeRoute,
} from './intent/route-intent.schema';
import { looksActionable } from './intent/router-keyword-filter';

export type RouterOutcome =
  | { status: 'dispatched'; route: RouteName; agentStatus: string }
  | { status: 'follow_up'; agent: 'calendar'; agentStatus: string }
  | { status: 'clarification_requested'; between: [RouteName, RouteName] }
  | { status: 'clarification_resolved'; route: RouteName; agentStatus: string }
  | { status: 'gave_up' }
  | { status: 'unrelated' }
  | { status: 'not_configured' }
  | { status: 'rate_limited'; retryAfterSeconds?: number }
  | { status: 'skipped'; reason: 'prefiltered' };

/**
 * What the user is told when routing cannot run at all.
 *
 * Deliberately about *us*, not them: they asked a perfectly good question and
 * the answer is that this deployment is missing a credential. Saying so beats
 * both silence and a generic "something went wrong".
 */
const NOT_CONFIGURED_MESSAGE =
  "I can't work out what to do with that right now — this assistant is " +
  "missing some configuration on my side, so I can't understand messages " +
  'until that is fixed. Nothing you sent has been lost.';

/**
 * Told to the user when the provider is rate limiting us for longer than the
 * retry policy can wait out.
 *
 * Names a rough wait rather than apologising vaguely: "try again in a minute"
 * is actionable, "something went wrong" is not.
 */
function rateLimitedMessage(retryAfterSeconds?: number): string {
  const wait = retryAfterSeconds
    ? `about ${Math.ceil(retryAfterSeconds)} seconds`
    : 'a moment';
  return (
    `I'm being rate limited right now, so I couldn't read that one. ` +
    `Try again in ${wait} — nothing you sent has been lost.`
  );
}

/** Either a classification, or the outcome to report because it degraded. */
type ClassifyResult =
  | { ok: true; decision: RoutingDecision }
  | { ok: false; outcome: RouterOutcome };

/**
 * The single classification and dispatch point.
 *
 * Every message is classified exactly once, here, and then handed to one agent.
 * Before Phase 4a each agent ran its own classifier and decided for itself
 * whether a message was its business, which meant up to two LLM calls and no
 * single place that knew where a message went.
 *
 * The ordering below is load-bearing:
 *
 *   1. An outstanding routing question — the user is answering *us*.
 *   2. An agent awaiting a follow-up — the user is answering *it*. This must
 *      precede classification: "yes" to a delete confirmation classifies as
 *      `unrelated`, which would strand the pending action and silently break
 *      every destructive-action confirmation from Phase 2.
 *   3. Attachments, which need no classification at all.
 *   4. The keyword pre-filter.
 *   5. Classify once, then dispatch.
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly defaultTimeZone: string;
  private readonly timeZoneOverride?: string;

  constructor(
    private readonly classifier: RouteClassifier,
    private readonly clarifications: PendingClarificationService,
    private readonly calendar: CalendarAgentService,
    private readonly rag: RagAgentService,
    private readonly telegram: TelegramSenderService,
    private readonly prisma: PrismaService,
    private readonly llmConfig: LlmConfigService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultTimeZone = config.get('DEFAULT_TIMEZONE', { infer: true });
    this.timeZoneOverride = config.get('TIMEZONE_OVERRIDE', { infer: true });
  }

  async handle(
    job: TelegramMessageJob,
    now = new Date(),
  ): Promise<RouterOutcome> {
    // 1. Are they answering our routing question?
    const pending = await this.clarifications.get(job.tenantId, now);
    if (pending) {
      return this.resolveClarification(job, now);
    }

    // 2. Is an agent awaiting a reply? Must precede classification.
    if (await this.calendar.claimsFollowUp(job.tenantId, now)) {
      const outcome = await this.calendar.handleFollowUp(job, now);

      // A decisive yes or no is done. An unclear reply is not necessarily a
      // bad answer — it may be the user changing their mind ("actually, cancel
      // my lunch instead"), which §25 established should supersede rather than
      // be answered with "I need a yes or no". Telling those apart needs the
      // classifier, so it falls through rather than replying here.
      if (outcome.status !== 'unclear_reply') {
        this.logger.log(
          `Calendar follow-up for message ${job.messageId}: ${outcome.status}`,
        );
        return {
          status: 'follow_up',
          agent: 'calendar',
          agentStatus: outcome.status,
        };
      }

      return this.resolveUnclearFollowUp(job, now);
    }

    // 3. An upload is unambiguous — no classification needed.
    if (attachmentOf(job)) {
      const outcome = await this.rag.handle(job, null);
      return {
        status: 'dispatched',
        route: 'rag_ingest',
        agentStatus: outcome.status,
      };
    }

    // 4. Cheap filter before the one LLM call.
    if (!looksActionable(job.text)) {
      this.logger.debug(
        `Pre-filtered as non-actionable: ${JSON.stringify(job.text)}`,
      );
      return { status: 'skipped', reason: 'prefiltered' };
    }

    // 5. Classify once.
    const result = await this.classifyOrDegrade(job, job.text, now);
    if (!result.ok) {
      return result.outcome;
    }

    return this.dispatch(job, result.decision, now);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    job: TelegramMessageJob,
    decision: RoutingDecision,
    now: Date,
  ): Promise<RouterOutcome> {
    switch (decision.route) {
      case 'ambiguous':
        return this.askForClarification(job, decision.between, 1, now);

      case 'calendar': {
        const outcome = await this.calendar.handle(job, decision.intent, now);
        this.logger.log(
          `Routed message ${job.messageId} to calendar: ${outcome.status} (${decision.reason})`,
        );
        return {
          status: 'dispatched',
          route: 'calendar',
          agentStatus: outcome.status,
        };
      }

      case 'rag_query':
      case 'rag_ingest': {
        const outcome = await this.rag.handle(job, decision.intent);
        this.logger.log(
          `Routed message ${job.messageId} to ${decision.route}: ${outcome.status} (${decision.reason})`,
        );
        return {
          status: 'dispatched',
          route: decision.route,
          agentStatus: outcome.status,
        };
      }

      case 'unrelated':
        // Scoped honesty rather than a generic apology: telling the user what
        // this assistant *can* do is more useful than telling them it failed.
        await this.telegram.sendMessage(
          job.chatId,
          "I can help with your calendar and with documents you've saved. " +
            "I can't help with that one yet.",
        );
        return { status: 'unrelated' };
    }
  }

  /**
   * An unclear reply to a pending confirmation: new request, or bad answer?
   *
   * Classifies to decide. An actionable route means the user moved on, so the
   * pending action is superseded — safe, because superseding only ever cancels
   * a destructive action, never performs one. Anything else means they answered
   * badly, and the confirmation stays open.
   */
  private async resolveUnclearFollowUp(
    job: TelegramMessageJob,
    now: Date,
  ): Promise<RouterOutcome> {
    if (!looksActionable(job.text)) {
      await this.calendar.askForClearConfirmation(job);
      return {
        status: 'follow_up',
        agent: 'calendar',
        agentStatus: 'clarification_requested',
      };
    }

    const followUp = await this.classifyOrDegrade(job, job.text, now);
    if (!followUp.ok) {
      // The pending confirmation is deliberately left standing: we could not
      // read this reply, so treating it as a supersede would silently cancel a
      // destructive action the user is still waiting on. It expires on its own.
      return followUp.outcome;
    }
    const decision = followUp.decision;

    if (decision.route === 'unrelated' || decision.route === 'ambiguous') {
      await this.calendar.askForClearConfirmation(job);
      return {
        status: 'follow_up',
        agent: 'calendar',
        agentStatus: 'clarification_requested',
      };
    }

    this.logger.debug(
      `New ${decision.route} request superseded a pending calendar action for ${job.tenantId}`,
    );
    await this.calendar.cancelPendingAction(job.tenantId);

    return this.dispatch(job, decision, now);
  }

  // -------------------------------------------------------------------------
  // Clarification
  // -------------------------------------------------------------------------

  private async askForClarification(
    job: TelegramMessageJob,
    between: [RouteName, RouteName],
    attempts: number,
    now: Date,
  ): Promise<RouterOutcome> {
    // The original text is stored, not the parsed intent: once the user picks a
    // route we re-extract against that route specifically, which is more
    // accurate than reusing fields the model filled while it was unsure.
    await this.clarifications.set(
      job.tenantId,
      job.text,
      between,
      attempts,
      now,
    );

    await this.telegram.sendMessage(
      job.chatId,
      `Did you mean ${describeRoute(between[0])}, or ${describeRoute(between[1])}?`,
    );

    this.logger.log(
      `Asked for clarification on message ${job.messageId}: ${between.join(' vs ')}`,
    );

    return { status: 'clarification_requested', between };
  }

  /**
   * Resolves the user's answer to a routing question.
   *
   * Note what does NOT happen here: the original message is not re-classified
   * from scratch. The user already told us the route, so we dispatch straight
   * to it and let that agent extract from the original text.
   */
  private async resolveClarification(
    job: TelegramMessageJob,
    now: Date,
  ): Promise<RouterOutcome> {
    // Checked before the claim: consuming the pending question and then failing
    // to act on it would lose it for good, where leaving it lets the user
    // answer again once the deployment is fixed.
    if (!this.llmConfig.isConfigured) {
      await this.replyNotConfigured(job);
      return { status: 'not_configured' };
    }

    const claimed = await this.clarifications.claim(job.tenantId, now);
    if (!claimed) {
      // Expired or another handler won the race — treat as a fresh message.
      return { status: 'skipped', reason: 'prefiltered' };
    }

    const chosen = interpretClarification(job.text, claimed.between);

    if (!chosen) {
      // Still unclear.
      //
      // MAX_ATTEMPTS is 1, so in the shipped configuration this always gives
      // up and the re-ask below never runs. That is the policy, not an
      // oversight: a second question costs the user a third message and rarely
      // lands when the first phrasing did not. The branch stays because the
      // constant is the single dial — raising it to 2 makes the re-ask live
      // without touching this logic.
      if (claimed.attempts >= PendingClarificationService.MAX_ATTEMPTS) {
        await this.telegram.sendMessage(
          job.chatId,
          "Sorry — I'm still not sure what you meant, so I'd rather not guess. " +
            'Try asking again with a bit more detail.',
        );
        this.logger.log(
          `Gave up clarifying for tenant ${job.tenantId} after ${claimed.attempts} attempt(s)`,
        );
        return { status: 'gave_up' };
      }

      return this.askForClarification(
        job,
        claimed.between,
        claimed.attempts + 1,
        now,
      );
    }

    // Re-run the original message against the chosen route only. This is a
    // second LLM call, but it happens only on the ambiguous path — the common
    // case still costs exactly one.
    const replayResult = await this.classifyOrDegrade(
      job,
      `${claimed.originalText}\n\n(The user has clarified this is ${describeRoute(chosen)}.)`,
      now,
    );
    if (!replayResult.ok) {
      return replayResult.outcome;
    }
    const decision = replayResult.decision;

    // Replay against the ORIGINAL job so replies go to the right chat, but
    // carry the clarified text so the agent sees what was actually asked.
    const replayed: TelegramMessageJob = {
      ...job,
      text: claimed.originalText,
    };

    const outcome = await this.dispatch(replayed, decision, now);

    return {
      status: 'clarification_resolved',
      route: chosen,
      agentStatus:
        outcome.status === 'dispatched' ? outcome.agentStatus : outcome.status,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Classifies, or degrades honestly when the model is not configured.
   *
   * Every classification in this service goes through here, which is the point:
   * the check is easy to forget at a call site, and forgetting it restores the
   * exact failure this exists to prevent — a 401 thrown into BullMQ, retried
   * three times, dropped in the failed set, with the user told nothing.
   *
   * Returns null when it has already replied to the user. Callers turn that
   * into `not_configured` rather than continuing.
   *
   * Note this covers *configuration*, not availability. A genuine outage or a
   * rate limit still throws, and should: those are transient, and retrying is
   * the right response. A missing credential is not transient, so retrying it
   * only delays telling the user something they need to hear.
   */
  private async classifyOrDegrade(
    job: TelegramMessageJob,
    text: string,
    now: Date,
  ): Promise<ClassifyResult> {
    if (!this.llmConfig.isConfigured) {
      await this.replyNotConfigured(job);
      return { ok: false, outcome: { status: 'not_configured' } };
    }

    try {
      const decision = await this.classifier.classify({
        text,
        timeZone: await this.timeZoneFor(job.tenantId),
        now,
      });
      return { ok: true, decision };
    } catch (error) {
      if (!(error instanceof LlmRequestError)) {
        throw error;
      }

      if (error.retryable) {
        // A short blip is exactly what the retry policy exists for, so rethrow
        // and let BullMQ back off.
        //
        // But when the provider names a wait LONGER than the policy's whole
        // window, retrying is theatre: observed live, a 429 saying "retry in
        // 19.8s" burned all three attempts inside 6s and the user got silence.
        // Better to say so immediately, while they are still looking at their
        // phone, than to fail three times in private.
        const waitsTooLong =
          error.retryAfterSeconds !== undefined &&
          error.retryAfterSeconds > RETRY_WINDOW_SECONDS;

        if (!waitsTooLong) {
          throw error;
        }

        this.logger.warn(
          `Rate limited on message ${job.messageId}: provider asked for ${error.retryAfterSeconds}s, ` +
            `longer than the ${RETRY_WINDOW_SECONDS}s retry window — telling the user instead of retrying.`,
        );
        await this.telegram.sendMessage(
          job.chatId,
          rateLimitedMessage(error.retryAfterSeconds),
        );
        return {
          ok: false,
          outcome: {
            status: 'rate_limited',
            retryAfterSeconds: error.retryAfterSeconds,
          },
        };
      }

      // A non-retryable one cannot succeed on attempt two. The credential is
      // wrong, the balance is empty, or the model does not exist — none of
      // which changes in the ~6s it takes to exhaust the attempts, during
      // which the user is told nothing and then still nothing.
      this.logger.error(
        `Cannot route message ${job.messageId}: ${error.status} from the model provider, not retryable — ${error.detail ?? error.message}`,
      );
      await this.telegram.sendMessage(job.chatId, NOT_CONFIGURED_MESSAGE);
      return { ok: false, outcome: { status: 'not_configured' } };
    }
  }

  private async replyNotConfigured(job: TelegramMessageJob): Promise<void> {
    this.logger.warn(
      `Cannot route message ${job.messageId}: ANTHROPIC_API_KEY is ` +
        `${this.llmConfig.missingVars.length > 0 ? 'missing' : 'a placeholder'}. ` +
        'Replying with the not-configured message instead of retrying.',
    );
    await this.telegram.sendMessage(job.chatId, NOT_CONFIGURED_MESSAGE);
  }

  /**
   * The tenant's cached calendar timezone.
   *
   * Read from the users table rather than fetched from Google: the router has
   * no calendar access by design, and fetching it previously cost an extra API
   * call on every calendar message. Falls back to the configured default for a
   * user who has never connected a calendar.
   */
  private async timeZoneFor(tenantId: string): Promise<string> {
    // Checked before the lookup, not after: an override that loses to a stale
    // cached value would be no override at all.
    if (this.timeZoneOverride) return this.timeZoneOverride;

    const user = await this.prisma.user.findUnique({
      where: { id: tenantId },
      select: { timeZone: true },
    });
    return user?.timeZone ?? this.defaultTimeZone;
  }
}
