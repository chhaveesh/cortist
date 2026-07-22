import { ConfigService } from '@nestjs/config';
import { CalendarAgentService } from '../../src/agents/calendar/calendar-agent.service';
import { RagAgentService } from '../../src/agents/rag/rag-agent.service';
import { TelegramMessageJob } from '../../src/common/contracts/telegram-message.job';
import { LlmConfigService } from '../../src/config/llm-config.service';
import { LlmRequestError } from '../../src/llm/llm-error';
import { PendingClarificationService } from '../../src/router/clarification/pending-clarification.service';
import { RouteClassifier } from '../../src/router/intent/route-classifier.service';
import { RouterService } from '../../src/router/router.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TelegramSenderService } from '../../src/telegram/outbound/telegram-sender.service';
import { RecordingTelegramSender } from '../fakes/recording-telegram-sender';

/**
 * What happens to a perfectly good message when ANTHROPIC_API_KEY is absent or
 * still holds its placeholder.
 *
 * Before this, nothing good: `AnthropicRouteClassifier` constructed happily
 * with a null key and threw `401 invalid x-api-key` at request time, BullMQ
 * retried it three times, and it landed in the failed set. The user was told
 * nothing at all, and since the processed marker is written *after* the agent
 * runs, `processed_messages` recorded nothing either — from the user's side the
 * message simply vanished.
 *
 * The calendar agent has answered this honestly since Phase 2 (§32); these
 * tests hold the router to the same standard, one layer up where it decides the
 * fate of every actionable message rather than one agent's.
 */
describe('router degradation when the model is not configured', () => {
  const JOB: TelegramMessageJob = {
    jobType: 'telegram_message',
    version: 1,
    tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    telegramUserId: '424242',
    chatId: '424242',
    messageId: 777001,
    text: 'book a dentist appointment tomorrow at 3pm',
    receivedAt: '2026-07-23T12:00:00.000Z',
  };

  function build(options: { apiKey?: string; hasPendingCalendar?: boolean }) {
    const telegram = new RecordingTelegramSender();

    const classifier = {
      classify: jest.fn(async () => {
        throw new Error('the classifier must not be called when unconfigured');
      }),
    } as unknown as RouteClassifier;

    const clarifications = {
      get: jest.fn(async () => null),
      claim: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
    } as unknown as PendingClarificationService;

    const calendar = {
      claimsFollowUp: jest.fn(async () => options.hasPendingCalendar ?? false),
      handleFollowUp: jest.fn(async () => ({ status: 'unclear_reply' })),
      cancelPendingAction: jest.fn(async () => undefined),
      askForClearConfirmation: jest.fn(async () => undefined),
      handle: jest.fn(),
    } as unknown as CalendarAgentService;

    const rag = { handle: jest.fn() } as unknown as RagAgentService;

    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({ timeZone: 'Europe/London' })),
      },
    } as unknown as PrismaService;

    // Per-key, not one value for every key: LlmConfigService reads
    // LLM_PROVIDER as well as the key itself.
    const llmConfig = new LlmConfigService({
      get: (key: string) =>
        key === 'LLM_PROVIDER' ? 'anthropic' : options.apiKey,
    } as unknown as ConfigService<never, true>);

    const router = new RouterService(
      classifier,
      clarifications,
      calendar,
      rag,
      telegram as unknown as TelegramSenderService,
      prisma,
      llmConfig,
      { get: () => 'UTC' } as unknown as ConfigService<never, true>,
    );

    const messagesFor = (chatId: string) =>
      telegram.sent.filter((message) => message.chatId === chatId);

    return {
      router,
      telegram,
      messagesFor,
      classifier,
      calendar,
      clarifications,
    };
  }

  describe.each([
    ['absent', undefined],
    ['a placeholder', 'sk-ant-your-key-here'],
  ])('with the key %s', (_label, apiKey) => {
    it('tells the user instead of throwing', async () => {
      const { router, messagesFor } = build({ apiKey });

      // The old behaviour was a thrown 401 here, which is the retry loop.
      const outcome = await router.handle(JOB);

      expect(outcome.status).toBe('not_configured');
      expect(messagesFor('424242')).toHaveLength(1);
      expect(messagesFor('424242')[0].text).toMatch(/configuration/i);
    });

    it('never calls the classifier', async () => {
      const { router, classifier } = build({ apiKey });
      await router.handle(JOB);
      expect(classifier.classify).not.toHaveBeenCalled();
    });

    it('replies to the chat the message came from', async () => {
      const { router, messagesFor } = build({ apiKey });
      await router.handle({ ...JOB, chatId: '-1001234567890' });
      expect(messagesFor('-1001234567890')).toHaveLength(1);
      expect(messagesFor('424242')).toHaveLength(0);
    });

    /**
     * The pending action must survive.
     *
     * An unclear reply to a delete confirmation normally goes to the classifier
     * to tell "no, cancel my lunch instead" (a supersede) from a bad answer.
     * Unconfigured, we cannot tell those apart — and guessing supersede would
     * silently cancel a destructive action the user is still waiting on.
     */
    it('leaves a pending calendar confirmation standing', async () => {
      const { router, calendar, messagesFor } = build({
        apiKey,
        hasPendingCalendar: true,
      });

      // Actionable text on purpose: a non-actionable reply ("hmm, maybe later")
      // is handled by the pre-filter and never needed the model, so it would
      // not exercise this path. This phrasing is the genuine supersede-or-bad-
      // answer case that only the classifier can settle.
      const outcome = await router.handle({
        ...JOB,
        text: 'actually, book lunch with Sam tomorrow at noon instead',
      });

      expect(outcome.status).toBe('not_configured');
      expect(calendar.cancelPendingAction).not.toHaveBeenCalled();
      expect(messagesFor('424242')).toHaveLength(1);
    });

    /**
     * A pending routing question must also survive, which is why the check runs
     * before the claim: claiming consumes the question, so failing after that
     * would lose it permanently rather than letting the user answer again once
     * the deployment is fixed.
     */
    it('does not consume a pending clarification', async () => {
      const { router, clarifications } = build({ apiKey });
      (clarifications.get as jest.Mock).mockResolvedValue({
        originalText: 'remind me about the Q3 report',
        between: ['calendar', 'rag_query'],
        attempts: 1,
      });

      const outcome = await router.handle({ ...JOB, text: 'the first one' });

      expect(outcome.status).toBe('not_configured');
      expect(clarifications.claim).not.toHaveBeenCalled();
    });

    /**
     * Small talk never needed the model, and must not start costing a reply
     * just because the model is unavailable.
     */
    it('still pre-filters small talk silently', async () => {
      const { router, messagesFor } = build({ apiKey });

      const outcome = await router.handle({
        ...JOB,
        text: 'thanks, good morning!',
      });

      expect(outcome.status).toBe('skipped');
      expect(messagesFor('424242')).toHaveLength(0);
    });
  });

  /**
   * A valid key is not the same as a usable account. An exhausted credit
   * balance returns 400 and will still be exhausted on attempt two — the
   * config check cannot see it, because the key itself is perfectly good.
   */
  describe('with a real key but a provider error', () => {
    it('degrades honestly on a non-retryable error', async () => {
      const { router, classifier, messagesFor } = build({
        apiKey: 'sk-ant-api03-real',
      });
      (classifier.classify as jest.Mock).mockRejectedValue(
        new LlmRequestError(
          'failed (400)',
          400,
          false,
          'credit balance too low',
        ),
      );

      const outcome = await router.handle(JOB);

      expect(outcome.status).toBe('not_configured');
      expect(messagesFor('424242')).toHaveLength(1);
    });

    it('rethrows a short retryable error so BullMQ backs off', async () => {
      const { router, classifier, messagesFor } = build({
        apiKey: 'sk-ant-api03-real',
      });
      (classifier.classify as jest.Mock).mockRejectedValue(
        new LlmRequestError('rate limited (429)', 429, true),
      );

      // Rethrown on purpose: a blip clears within the retry window.
      await expect(router.handle(JOB)).rejects.toThrow(/429/);
      expect(messagesFor('424242')).toHaveLength(0);
    });

    /**
     * Observed live: a 429 saying "retry in 19.8s" against a policy that fires
     * at 2s and 4s burned all three attempts inside the window it was told to
     * wait out, then dropped the message with the user told nothing.
     */
    it('tells the user when the wait exceeds the retry window', async () => {
      const { router, classifier, messagesFor } = build({
        apiKey: 'sk-ant-api03-real',
      });
      (classifier.classify as jest.Mock).mockRejectedValue(
        new LlmRequestError('rate limited (429)', 429, true, 'quota', 19.8),
      );

      const outcome = await router.handle(JOB);

      expect(outcome).toEqual({
        status: 'rate_limited',
        retryAfterSeconds: 19.8,
      });
      // Named, not vague: "try again in ~20 seconds" is actionable.
      expect(messagesFor('424242')[0].text).toMatch(/20 seconds/);
    });

    it('still retries when the wait fits inside the window', async () => {
      const { router, classifier } = build({ apiKey: 'sk-ant-api03-real' });
      (classifier.classify as jest.Mock).mockRejectedValue(
        new LlmRequestError('rate limited (429)', 429, true, 'quota', 2),
      );

      await expect(router.handle(JOB)).rejects.toThrow(/429/);
    });
  });

  describe('with a real key', () => {
    it('reports configured and routes normally', async () => {
      const { router, classifier } = build({ apiKey: 'sk-ant-api03-real' });
      (classifier.classify as jest.Mock).mockResolvedValue({
        route: 'unrelated',
        reason: 'not actionable',
        confidence: 'high',
      });

      const outcome = await router.handle(JOB);

      expect(outcome.status).not.toBe('not_configured');
      expect(classifier.classify).toHaveBeenCalledTimes(1);
    });
  });
});
