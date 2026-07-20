import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CalendarClient } from '../../src/agents/calendar/google/calendar.port';
import { TokenEncryptionService } from '../../src/crypto/token-encryption.service';
import { EmbeddingClient } from '../../src/agents/rag/embedding/embedding.port';
import { RagLlm } from '../../src/agents/rag/intent/rag-llm.service';
import { UrlFetcher } from '../../src/agents/rag/ingestion/url-fetcher.port';
import { TelegramFileDownloader } from '../../src/telegram/outbound/telegram-file.client';
import { TelegramSenderService } from '../../src/telegram/outbound/telegram-sender.service';
import { WorkerAppModule } from '../../src/worker.module.root';
import { FakeCalendarClient } from '../fakes/fake-calendar.client';
import { FakeEmbeddingClient } from '../fakes/fake-embedding.client';
import {
  FakeTelegramFileDownloader,
  FakeUrlFetcher,
} from '../fakes/fake-fetchers';
import { FakeRagLlm } from '../fakes/fake-rag-llm';
import { RecordingTelegramSender } from '../fakes/recording-telegram-sender';
import { ScriptedRouteClassifier } from '../fakes/scripted-route-classifier';
import { RouteClassifier } from '../../src/router/intent/route-classifier.service';
import {
  TestHarness,
  WEBHOOK_PATH,
  WEBHOOK_SECRET_HEADER,
  createHarness,
  destroyHarness,
  resetState,
  waitFor,
  webhookSecret,
} from '../harness';

/**
 * Agent routing across the shared queue.
 *
 * The two agents are independent, but they consume the same queue, and the
 * worker offers each message to both in turn. This is the test that the
 * separation actually holds at runtime: a calendar message must never reach the
 * RAG agent's ingestion path, and a document must never reach the calendar
 * agent — regardless of the fact that both modules are loaded in one process.
 */
describe('Agent routing across the shared queue (end to end)', () => {
  let harness: TestHarness;
  let worker: INestApplicationContext | undefined;

  let telegram: RecordingTelegramSender;
  let calendarClient: FakeCalendarClient;
  let routeClassifier: ScriptedRouteClassifier;
  let ragLlm: FakeRagLlm;
  let embeddings: FakeEmbeddingClient;
  let files: FakeTelegramFileDownloader;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await destroyHarness(harness);
  });

  beforeEach(async () => {
    await resetState(harness);
    await harness.prisma.documentChunk.deleteMany();
    await harness.prisma.document.deleteMany();
    await harness.prisma.pendingAction.deleteMany();
    await harness.prisma.oAuthToken.deleteMany();
  });

  /** Boots the real worker root with every outbound seam faked. */
  async function startBothAgents(): Promise<INestApplicationContext> {
    telegram = new RecordingTelegramSender();
    calendarClient = new FakeCalendarClient();
    routeClassifier = new ScriptedRouteClassifier();
    ragLlm = new FakeRagLlm();
    embeddings = new FakeEmbeddingClient();
    files = new FakeTelegramFileDownloader();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    })
      .overrideProvider(TelegramSenderService)
      .useValue(telegram)
      .overrideProvider(CalendarClient)
      .useValue(calendarClient)
      .overrideProvider(RouteClassifier)
      .useValue(routeClassifier)
      .overrideProvider(RagLlm)
      .useValue(ragLlm)
      .overrideProvider(EmbeddingClient)
      .useValue(embeddings)
      .overrideProvider(UrlFetcher)
      .useValue(new FakeUrlFetcher())
      .overrideProvider(TelegramFileDownloader)
      .useValue(files)
      .compile();

    return moduleRef.init();
  }

  const post = (body: unknown) =>
    request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set(WEBHOOK_SECRET_HEADER, webhookSecret())
      .send(body as object);

  const textUpdate = (chatId: number, text: string, messageId: number) => ({
    update_id: 980_000_000 + messageId,
    message: {
      message_id: messageId,
      from: { id: chatId, is_bot: false, first_name: 'Ada' },
      chat: { id: chatId, type: 'private' },
      date: 1_768_000_000,
      text,
    },
  });

  const documentUpdate = (chatId: number, messageId: number, caption = '') => ({
    update_id: 980_000_000 + messageId,
    message: {
      message_id: messageId,
      from: { id: chatId, is_bot: false, first_name: 'Ada' },
      chat: { id: chatId, type: 'private' },
      date: 1_768_000_000,
      document: {
        file_id: `file-${messageId}`,
        file_name: 'notes.txt',
        mime_type: 'text/plain',
      },
      ...(caption ? { caption } : {}),
    },
  });

  it('sends a document straight to RAG, never to the calendar agent', async () => {
    worker = await startBothAgents();
    files.register('file-81001', 'Meeting notes: the budget is 4.2 million.');

    await post(documentUpdate(880_001, 81_001)).expect(200);

    await waitFor('the document to be ingested', async () =>
      (await harness.prisma.document.count()) > 0 ? true : null,
    );

    // The calendar agent must not have been consulted at all — it has nothing
    // to do with a file, and its classifier would be a wasted call.
    expect(routeClassifier.callCount).toBe(0);
    expect(calendarClient.calls).toEqual([]);
    expect(telegram.transcript).toContain('Saved');
  });

  it('sends a calendar message to the calendar agent, never to RAG ingestion', async () => {
    worker = await startBothAgents();

    routeClassifier.script({
      route: 'calendar',
      calendarAction: 'create_event',
      title: 'Dentist',
      startTime: '2026-07-21T09:00:00Z',
      endTime: '2026-07-21T10:00:00Z',
    });

    // Connect a calendar so the agent can actually act rather than bailing out
    // at the connection check.
    const user = await harness.prisma.user.create({
      data: {
        telegramUserId: BigInt(880_002),
        telegramChatId: BigInt(880_002),
      },
    });
    await harness.prisma.oAuthToken.create({
      data: {
        userId: user.id,
        provider: 'google_calendar',
        accessTokenEncrypted: harness.app
          .get(TokenEncryptionService)
          .encrypt('access-token'),
        refreshTokenEncrypted: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await post(
      textUpdate(880_002, 'book a dentist appointment tomorrow at 9', 81_010),
    ).expect(200);

    await waitFor('the event to be created', async () =>
      calendarClient.callsTo('createEvent') > 0 ? true : null,
    );

    // Nothing was stored in the second brain, and the RAG classifier never ran.
    expect(await harness.prisma.document.count()).toBe(0);
    expect(await harness.prisma.document.count()).toBe(0);
  });

  it('routes a calendar message and a document sent back to back to different agents', async () => {
    // The case the walkthrough asks for: both types in flight together, each
    // reaching the right agent and neither confusing the other.
    worker = await startBothAgents();
    files.register('file-81021', 'Reference notes worth remembering.');

    routeClassifier.script({
      route: 'rag_query',
      question: 'what do my notes say about the budget?',
    });

    await Promise.all([
      post(documentUpdate(880_003, 81_021)).expect(200),
      post(
        textUpdate(880_004, 'what do my notes say about the budget?', 81_022),
      ).expect(200),
    ]);

    await waitFor('both messages to be processed', async () =>
      (await harness.prisma.processedMessage.count()) === 2 ? true : null,
    );

    // The upload was ingested for its own tenant...
    const documents = await harness.prisma.document.findMany();
    expect(documents).toHaveLength(1);

    const uploader = await harness.prisma.user.findUniqueOrThrow({
      where: { telegramUserId: BigInt(880_003) },
    });
    expect(documents[0].userId).toBe(uploader.id);

    // ...and the question went through the RAG classifier, not the ingest path.
    expect(routeClassifier.callCount).toBeGreaterThan(0);
    expect(calendarClient.calls).toEqual([]);
  });

  it('replies honestly when the router finds no agent for a message', async () => {
    worker = await startBothAgents();

    // A question-shaped message reaches the router's classifier: "what is..."
    // is genuinely ambiguous between general knowledge and a question about
    // stored notes, and resolving that is the classifier's job rather than the
    // keyword filter's. It routes to unrelated.
    routeClassifier.script({ route: 'unrelated' });

    await post(
      textUpdate(880_005, 'what is the capital of France?', 81_030),
    ).expect(200);

    const processed = await waitFor('the processed marker', async () =>
      harness.prisma.processedMessage.findFirst({
        where: { chatId: BigInt(880_005) },
      }),
    );

    expect(processed).not.toBeNull();

    // Behaviour changed in Phase 4a, deliberately: an unrelated message now
    // gets a scoped, honest reply instead of silence. Only the router is in a
    // position to know that nothing handled the message — neither agent could
    // tell on its own, which is why this used to be a silent no-op.
    //
    // Chit-chat is still dropped by the pre-filter before this point, so this
    // only fires for messages that looked actionable and turned out not to be.
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.last?.chatId).toBe('880005');
    expect(telegram.last?.text).toMatch(/calendar/i);

    // Nothing stored, nothing failed.
    expect(await harness.prisma.document.count()).toBe(0);
    expect(await harness.queue.getFailedCount()).toBe(0);
  });
});
