import { ConfigService } from '@nestjs/config';
import { CalendarAgentService } from '../../src/agents/calendar/calendar-agent.service';
import { RagAgentService } from '../../src/agents/rag/rag-agent.service';
import { TelegramMessageJob } from '../../src/common/contracts/telegram-message.job';
import { LlmConfigService } from '../../src/config/llm-config.service';
import { PendingClarificationService } from '../../src/router/clarification/pending-clarification.service';
import { RouteClassifier } from '../../src/router/intent/route-classifier.service';
import { RouterService } from '../../src/router/router.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TelegramSenderService } from '../../src/telegram/outbound/telegram-sender.service';
import { RecordingTelegramSender } from '../fakes/recording-telegram-sender';

/**
 * `TIMEZONE_OVERRIDE` — one timezone for every user.
 *
 * A blunt instrument, and knowingly so. Per-user zones come from the calendar's
 * own setting, which proved unreliable in practice: a real account reported no
 * timezone, the client substituted UTC, and every "11:30am" for that user
 * landed at 17:00 on their own phone. Pinning a known-correct zone is more
 * honest than deriving a wrong one, until per-user timezones are handled
 * properly.
 *
 * The property that matters is precedence: the override must beat a cached
 * per-user value, or it is not an override at all.
 */
describe('TIMEZONE_OVERRIDE', () => {
  const JOB: TelegramMessageJob = {
    jobType: 'telegram_message',
    version: 1,
    tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    telegramUserId: '424242',
    chatId: '424242',
    messageId: 1,
    text: 'book a dentist appointment tomorrow at 3pm',
    receivedAt: '2026-07-23T12:00:00.000Z',
  };

  function build(options: { override?: string; storedZone: string | null }) {
    const classifier = {
      classify: jest.fn(async () => ({
        route: 'unrelated' as const,
        reason: 'test',
      })),
    } as unknown as RouteClassifier;

    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({ timeZone: options.storedZone })),
      },
    } as unknown as PrismaService;

    const config = {
      get: (key: string) =>
        key === 'TIMEZONE_OVERRIDE' ? options.override : 'UTC',
    } as unknown as ConfigService<never, true>;

    const router = new RouterService(
      classifier,
      {
        get: jest.fn(async () => null),
      } as unknown as PendingClarificationService,
      {
        claimsFollowUp: jest.fn(async () => false),
      } as unknown as CalendarAgentService,
      { handle: jest.fn() } as unknown as RagAgentService,
      new RecordingTelegramSender() as unknown as TelegramSenderService,
      prisma,
      new LlmConfigService({
        get: (key: string) =>
          key === 'LLM_PROVIDER' ? 'gemini' : 'AQ.a-real-key',
      } as unknown as ConfigService<never, true>),
      config,
    );

    return { router, classifier, prisma };
  }

  it('overrides the zone stored for the user', async () => {
    // The stored value is the failure mode this exists for: a calendar that
    // reported UTC for a user who is not in UTC.
    const { router, classifier } = build({
      override: 'Asia/Kolkata',
      storedZone: 'UTC',
    });

    await router.handle(JOB);

    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Asia/Kolkata' }),
    );
  });

  it('does not even read the stored zone when pinned', async () => {
    // Precedence proved structurally, not just by result: a lookup that runs
    // and is then discarded would pass the test above while leaving room for
    // the value to win somewhere else later.
    const { router, prisma } = build({
      override: 'Asia/Kolkata',
      storedZone: 'Europe/London',
    });

    await router.handle(JOB);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('uses the per-user zone when no override is set', async () => {
    const { router, classifier } = build({ storedZone: 'Europe/London' });

    await router.handle(JOB);

    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Europe/London' }),
    );
  });

  it('falls back to DEFAULT_TIMEZONE for a user with no stored zone', async () => {
    const { router, classifier } = build({ storedZone: null });

    await router.handle(JOB);

    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'UTC' }),
    );
  });
});
