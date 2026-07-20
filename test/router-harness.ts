import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CalendarAgentService } from '../src/agents/calendar/calendar-agent.service';
import { CalendarClient } from '../src/agents/calendar/google/calendar.port';
import { EmbeddingClient } from '../src/agents/rag/embedding/embedding.port';
import { IngestionService } from '../src/agents/rag/ingestion/ingestion.service';
import { UrlFetcher } from '../src/agents/rag/ingestion/url-fetcher.port';
import { RagLlm } from '../src/agents/rag/intent/rag-llm.service';
import { RagAgentService } from '../src/agents/rag/rag-agent.service';
import { PendingClarificationService } from '../src/router/clarification/pending-clarification.service';
import { RouteClassifier } from '../src/router/intent/route-classifier.service';
import { RouterModule } from '../src/router/router.module';
import { RouterService } from '../src/router/router.service';
import { registerBigIntJson } from '../src/common/bigint-json';
import { GoogleOAuthClient } from '../src/oauth/google-oauth.client';
import { OAuthTokenService } from '../src/oauth/oauth-token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramFileDownloader } from '../src/telegram/outbound/telegram-file.client';
import { TelegramSenderService } from '../src/telegram/outbound/telegram-sender.service';
import { FakeCalendarClient } from './fakes/fake-calendar.client';
import { FakeEmbeddingClient } from './fakes/fake-embedding.client';
import {
  FakeTelegramFileDownloader,
  FakeUrlFetcher,
} from './fakes/fake-fetchers';
import { FakeGoogleOAuthClient } from './fakes/fake-google-oauth.client';
import { FakeRagLlm } from './fakes/fake-rag-llm';
import { RecordingTelegramSender } from './fakes/recording-telegram-sender';
import { ScriptedRouteClassifier } from './fakes/scripted-route-classifier';

registerBigIntJson();

/**
 * Phase 4a harness — the router with both real agents behind it.
 *
 * The agents are NOT faked. That is the point: these tests prove dispatch
 * actually reaches each agent's logic and that Phases 2 and 3 still behave
 * correctly when invoked through the router, rather than only when driven
 * directly. Only the outbound seams are replaced.
 */
export interface RouterHarness {
  app: INestApplication;
  prisma: PrismaService;
  router: RouterService;

  classifier: ScriptedRouteClassifier;
  telegram: RecordingTelegramSender;
  calendarClient: FakeCalendarClient;
  ragLlm: FakeRagLlm;
  embeddings: FakeEmbeddingClient;
  files: FakeTelegramFileDownloader;
  urls: FakeUrlFetcher;
  googleOAuth: FakeGoogleOAuthClient;

  calendar: CalendarAgentService;
  rag: RagAgentService;
  ingestion: IngestionService;
  tokens: OAuthTokenService;
  clarifications: PendingClarificationService;
}

export async function createRouterHarness(): Promise<RouterHarness> {
  const classifier = new ScriptedRouteClassifier();
  const telegram = new RecordingTelegramSender();
  const calendarClient = new FakeCalendarClient();
  const ragLlm = new FakeRagLlm();
  const embeddings = new FakeEmbeddingClient();
  const files = new FakeTelegramFileDownloader();
  const urls = new FakeUrlFetcher();
  const googleOAuth = new FakeGoogleOAuthClient();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, RouterModule],
  })
    .overrideProvider(RouteClassifier)
    .useValue(classifier)
    .overrideProvider(TelegramSenderService)
    .useValue(telegram)
    .overrideProvider(CalendarClient)
    .useValue(calendarClient)
    .overrideProvider(RagLlm)
    .useValue(ragLlm)
    .overrideProvider(EmbeddingClient)
    .useValue(embeddings)
    .overrideProvider(TelegramFileDownloader)
    .useValue(files)
    .overrideProvider(UrlFetcher)
    .useValue(urls)
    .overrideProvider(GoogleOAuthClient)
    .useValue(googleOAuth)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    router: app.get(RouterService),
    classifier,
    telegram,
    calendarClient,
    ragLlm,
    embeddings,
    files,
    urls,
    googleOAuth,
    calendar: app.get(CalendarAgentService),
    rag: app.get(RagAgentService),
    ingestion: app.get(IngestionService),
    tokens: app.get(OAuthTokenService),
    clarifications: app.get(PendingClarificationService),
  };
}

export async function destroyRouterHarness(
  harness: RouterHarness,
): Promise<void> {
  await harness.app.close();
}

export async function resetRouterState(harness: RouterHarness): Promise<void> {
  harness.classifier.reset();
  harness.telegram.reset();
  harness.calendarClient.reset();
  harness.ragLlm.reset();
  harness.embeddings.reset();
  harness.files.reset();
  harness.urls.reset();
  harness.googleOAuth.reset();

  await harness.prisma.pendingClarification.deleteMany();
  await harness.prisma.pendingAction.deleteMany();
  await harness.prisma.documentChunk.deleteMany();
  await harness.prisma.document.deleteMany();
  await harness.prisma.oAuthToken.deleteMany();
  await harness.prisma.processedMessage.deleteMany();
  await harness.prisma.user.deleteMany();
}

export async function seedRouterTenant(
  harness: RouterHarness,
  telegramUserId = 660_000_001,
  timeZone: string | null = 'Europe/London',
): Promise<string> {
  const user = await harness.prisma.user.create({
    data: {
      telegramUserId: BigInt(telegramUserId),
      telegramChatId: BigInt(telegramUserId),
      timeZone,
    },
  });
  return user.id;
}

/** Gives the tenant a connected calendar, so calendar dispatch can act. */
export async function connectRouterCalendar(
  harness: RouterHarness,
  tenantId: string,
): Promise<void> {
  await harness.tokens.store(tenantId, {
    accessToken: 'stored-access-token',
    refreshToken: 'stored-refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

export function routerJob(
  tenantId: string,
  text: string,
  options: {
    messageId?: number;
    attachment?: { fileId: string; fileName?: string; mimeType?: string };
  } = {},
) {
  return {
    jobType: 'telegram_message' as const,
    version: 2 as const,
    tenantId,
    telegramUserId: '660000001',
    chatId: '660000001',
    messageId: options.messageId ?? 1,
    text,
    receivedAt: new Date().toISOString(),
    ...(options.attachment ? { attachment: options.attachment } : {}),
  };
}
