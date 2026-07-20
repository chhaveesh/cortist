import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { RagAgentModule } from '../src/agents/rag/rag-agent.module';
import { RagAgentService } from '../src/agents/rag/rag-agent.service';
import { EmbeddingClient } from '../src/agents/rag/embedding/embedding.port';
import { IngestionService } from '../src/agents/rag/ingestion/ingestion.service';
import { UrlFetcher } from '../src/agents/rag/ingestion/url-fetcher.port';
import { RagLlm } from '../src/agents/rag/intent/rag-llm.service';
import { RetrievalService } from '../src/agents/rag/retrieval/retrieval.service';
import { VectorStoreService } from '../src/agents/rag/retrieval/vector-store.service';
import { registerBigIntJson } from '../src/common/bigint-json';
import { PrismaService } from '../src/prisma/prisma.service';
import { TelegramFileDownloader } from '../src/telegram/outbound/telegram-file.client';
import { TelegramSenderService } from '../src/telegram/outbound/telegram-sender.service';
import { FakeEmbeddingClient } from './fakes/fake-embedding.client';
import {
  FakeTelegramFileDownloader,
  FakeUrlFetcher,
} from './fakes/fake-fetchers';
import { FakeRagLlm } from './fakes/fake-rag-llm';
import { RecordingTelegramSender } from './fakes/recording-telegram-sender';

registerBigIntJson();

/**
 * Phase 3 harness.
 *
 * Four provider overrides — embeddings, LLM, URL fetch, file download — plus the
 * Telegram sender. Those are the RAG agent's only routes off this machine, so
 * "no real API calls in CI" holds structurally, and the network guard in
 * test/network-guard.ts enforces it on every run.
 *
 * Postgres and pgvector are real: the tenant isolation guarantee lives in SQL,
 * and a faked store would prove nothing about it.
 */
export interface RagHarness {
  app: INestApplication;
  prisma: PrismaService;
  agent: RagAgentService;
  ingestion: IngestionService;
  retrieval: RetrievalService;
  store: VectorStoreService;

  embeddings: FakeEmbeddingClient;
  llm: FakeRagLlm;
  urls: FakeUrlFetcher;
  files: FakeTelegramFileDownloader;
  telegram: RecordingTelegramSender;
}

export async function createRagHarness(): Promise<RagHarness> {
  const embeddings = new FakeEmbeddingClient();
  const llm = new FakeRagLlm();
  const urls = new FakeUrlFetcher();
  const files = new FakeTelegramFileDownloader();
  const telegram = new RecordingTelegramSender();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, RagAgentModule],
  })
    .overrideProvider(EmbeddingClient)
    .useValue(embeddings)
    .overrideProvider(RagLlm)
    .useValue(llm)
    .overrideProvider(UrlFetcher)
    .useValue(urls)
    .overrideProvider(TelegramFileDownloader)
    .useValue(files)
    .overrideProvider(TelegramSenderService)
    .useValue(telegram)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    agent: app.get(RagAgentService),
    ingestion: app.get(IngestionService),
    retrieval: app.get(RetrievalService),
    store: app.get(VectorStoreService),
    embeddings,
    llm,
    urls,
    files,
    telegram,
  };
}

export async function destroyRagHarness(harness: RagHarness): Promise<void> {
  await harness.app.close();
}

export async function resetRagState(harness: RagHarness): Promise<void> {
  harness.embeddings.reset();
  harness.llm.reset();
  harness.urls.reset();
  harness.files.reset();
  harness.telegram.reset();

  // Chunks cascade from documents, but delete explicitly so a broken cascade
  // shows up as a test failure rather than as mysterious cross-test bleed.
  await harness.prisma.documentChunk.deleteMany();
  await harness.prisma.document.deleteMany();
  await harness.prisma.processedMessage.deleteMany();
  await harness.prisma.user.deleteMany();
}

export async function seedRagTenant(
  harness: RagHarness,
  telegramUserId: number,
): Promise<string> {
  const user = await harness.prisma.user.create({
    data: {
      telegramUserId: BigInt(telegramUserId),
      telegramChatId: BigInt(telegramUserId),
    },
  });
  return user.id;
}

/**
 * A minimal stand-in for the router's dispatch — see the calendar harness note.
 *
 * An attachment carries no intent: uploads are unambiguous and the router sends
 * them straight to ingestion without classifying.
 */
export async function routeToRag(
  harness: RagHarness,
  job: Parameters<RagAgentService['handle']>[0],
) {
  if (job.version === 2 && job.attachment) {
    return harness.agent.handle(job, null);
  }

  const intent = await harness.llm.classify(job.text);
  return harness.agent.handle(job, intent);
}

/** Builds a v2 job payload, as the gateway would produce it. */
export function buildRagJob(
  tenantId: string,
  text: string,
  options: {
    chatId?: string;
    messageId?: number;
    attachment?: {
      fileId: string;
      fileName?: string;
      mimeType?: string;
      fileSize?: number;
    };
  } = {},
) {
  return {
    jobType: 'telegram_message' as const,
    version: 2 as const,
    tenantId,
    telegramUserId: options.chatId ?? '900100100',
    chatId: options.chatId ?? '900100100',
    messageId: options.messageId ?? 1,
    text,
    receivedAt: new Date().toISOString(),
    ...(options.attachment ? { attachment: options.attachment } : {}),
  };
}
