import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { CalendarAgentService } from '../src/agents/calendar/calendar-agent.service';
import { CalendarAgentModule } from '../src/agents/calendar/calendar-agent.module';
import { CalendarClient } from '../src/agents/calendar/google/calendar.port';
import { CalendarIntentClassifier } from '../src/agents/calendar/intent/calendar-intent.service';
import { PendingActionService } from '../src/agents/calendar/pending-action/pending-action.service';
import { registerBigIntJson } from '../src/common/bigint-json';
import { GoogleOAuthClient } from '../src/oauth/google-oauth.client';
import { OAuthStateService } from '../src/oauth/oauth-state.service';
import { OAuthTokenService } from '../src/oauth/oauth-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramSenderService } from '../src/telegram/outbound/telegram-sender.service';
import { TokenEncryptionService } from '../src/crypto/token-encryption.service';
import { FakeCalendarClient } from './fakes/fake-calendar.client';
import { FakeGoogleOAuthClient } from './fakes/fake-google-oauth.client';
import { RecordingTelegramSender } from './fakes/recording-telegram-sender';
import { ScriptedIntentClassifier } from './fakes/scripted-intent.classifier';
import { redisConnectionOptions } from './harness';

registerBigIntJson();

/**
 * Phase 2 harness.
 *
 * Boots the gateway (for the OAuth endpoints) plus the calendar agent, with the
 * three outward-facing dependencies replaced by fakes:
 *
 *   CalendarClient           → FakeCalendarClient
 *   CalendarIntentClassifier → ScriptedIntentClassifier
 *   GoogleOAuthClient        → FakeGoogleOAuthClient
 *   TelegramSenderService    → RecordingTelegramSender
 *
 * Those four overrides are the only route the code has to Google, Anthropic, or
 * Telegram — so "no real network calls in CI" holds structurally, not by
 * convention. Kept separate from the Phase 1 harness so the existing pipe and
 * webhook suites keep exercising the unmodified wiring.
 */
export interface CalendarHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  agent: CalendarAgentService;

  calendar: FakeCalendarClient;
  classifier: ScriptedIntentClassifier;
  telegram: RecordingTelegramSender;
  googleOAuth: FakeGoogleOAuthClient;

  tokens: OAuthTokenService;
  oauthState: OAuthStateService;
  pending: PendingActionService;
  encryption: TokenEncryptionService;
}

export async function createCalendarHarness(): Promise<CalendarHarness> {
  const calendar = new FakeCalendarClient();
  const classifier = new ScriptedIntentClassifier();
  const telegram = new RecordingTelegramSender();
  const googleOAuth = new FakeGoogleOAuthClient();

  const moduleRef = await Test.createTestingModule({
    // CalendarAgentModule is imported alongside AppModule so the agent is
    // reachable here; in production it is loaded only by the worker root.
    imports: [AppModule, CalendarAgentModule],
  })
    .overrideProvider(CalendarClient)
    .useValue(calendar)
    .overrideProvider(CalendarIntentClassifier)
    .useValue(classifier)
    .overrideProvider(TelegramSenderService)
    .useValue(telegram)
    .overrideProvider(GoogleOAuthClient)
    .useValue(googleOAuth)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    redis: new Redis(redisConnectionOptions()),
    agent: app.get(CalendarAgentService),
    calendar,
    classifier,
    telegram,
    googleOAuth,
    tokens: app.get(OAuthTokenService),
    oauthState: app.get(OAuthStateService),
    pending: app.get(PendingActionService),
    encryption: app.get(TokenEncryptionService),
  };
}

export async function destroyCalendarHarness(
  harness: CalendarHarness,
): Promise<void> {
  await harness.redis.quit();
  await harness.app.close();
}

export async function resetCalendarState(
  harness: CalendarHarness,
): Promise<void> {
  harness.calendar.reset();
  harness.classifier.reset();
  harness.telegram.reset();
  harness.googleOAuth.reset();

  await harness.redis.flushdb();
  // Order matters: both child tables reference users.
  await harness.prisma.pendingAction.deleteMany();
  await harness.prisma.oAuthToken.deleteMany();
  await harness.prisma.processedMessage.deleteMany();
  await harness.prisma.user.deleteMany();
}

/** Creates a tenant row and returns its internal id. */
export async function seedTenant(
  harness: CalendarHarness,
  telegramUserId = 900_100_100,
  chatId = 900_100_100,
): Promise<string> {
  const user = await harness.prisma.user.create({
    data: {
      telegramUserId: BigInt(telegramUserId),
      telegramChatId: BigInt(chatId),
    },
  });
  return user.id;
}

/** Stores a connected-calendar token for a tenant. */
export async function connectCalendar(
  harness: CalendarHarness,
  tenantId: string,
  options: { expiresAt?: Date; refreshToken?: string } = {},
): Promise<void> {
  await harness.tokens.store(tenantId, {
    accessToken: 'stored-access-token',
    refreshToken: options.refreshToken ?? 'stored-refresh-token',
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
  });
}

/** Builds a queue job payload, as the gateway would have produced it. */
export function buildJob(
  tenantId: string,
  text: string,
  overrides: { chatId?: string; messageId?: number } = {},
) {
  return {
    jobType: 'telegram_message' as const,
    version: 1 as const,
    tenantId,
    telegramUserId: '900100100',
    chatId: overrides.chatId ?? '900100100',
    messageId: overrides.messageId ?? 1,
    text,
    receivedAt: new Date().toISOString(),
  };
}
