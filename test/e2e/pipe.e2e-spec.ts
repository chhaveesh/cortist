import { INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { buildTelegramUpdate } from '../fixtures/telegram-update.fixture';
import {
  TestHarness,
  WEBHOOK_PATH,
  WEBHOOK_SECRET_HEADER,
  createHarness,
  destroyHarness,
  resetState,
  startWorker,
  waitFor,
  webhookSecret,
} from '../harness';

/**
 * The full chain: HTTP webhook -> Redis queue -> worker process -> Postgres.
 *
 * The worker is booted from its own composition root (WorkerAppModule), the
 * same one `dist/worker.js` uses in production — so this exercises the real
 * process boundary, not a hand-rolled stand-in.
 */
describe('Gateway -> queue -> worker (end to end)', () => {
  let harness: TestHarness;
  let worker: INestApplicationContext | undefined;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    // Shut the worker down between tests so the next one can observe the queue
    // before anything drains it.
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await destroyHarness(harness);
  });

  beforeEach(async () => {
    await resetState(harness);
  });

  const post = (body: unknown) =>
    request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set(WEBHOOK_SECRET_HEADER, webhookSecret())
      .send(body as object);

  it('delivers a webhook message all the way to the worker', async () => {
    const telegramUserId = 888_000_111;
    const chatId = 888_000_111;
    const messageId = 55_501;
    const text = 'Book a dentist appointment next week';

    // 1. Gateway accepts and enqueues.
    const response = await post(
      buildTelegramUpdate({ telegramUserId, chatId, messageId, text }),
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('enqueued');

    // 2. The job is genuinely waiting on the queue before any worker exists.
    expect(await harness.queue.getWaitingCount()).toBe(1);
    expect(await harness.prisma.processedMessage.count()).toBe(0);

    // 3. Start the worker.
    worker = await startWorker();

    // 4. It consumes the job and writes the processed marker.
    const processed = await waitFor('the processed_messages row', async () =>
      harness.prisma.processedMessage.findFirst({
        where: { chatId: BigInt(chatId), messageId },
      }),
    );

    const user = await harness.prisma.user.findUniqueOrThrow({
      where: { telegramUserId: BigInt(telegramUserId) },
    });

    expect(processed.tenantId).toBe(user.id);
    expect(processed.text).toBe(text);

    // 5. The queue drains.
    await waitFor('the queue to drain', async () =>
      (await harness.queue.getWaitingCount()) === 0 ? true : null,
    );

    const completed = await harness.queue.getJobs(['completed']);
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(`tg:${chatId}:${messageId}`);
  });

  it('processes a backlog of queued messages once the worker starts', async () => {
    const telegramUserId = 888_000_222;
    const messageIds = [601, 602, 603, 604, 605];

    for (const messageId of messageIds) {
      await post(
        buildTelegramUpdate({
          telegramUserId,
          chatId: telegramUserId,
          messageId,
          text: `message ${messageId}`,
        }),
      ).expect(200);
    }

    expect(await harness.queue.getWaitingCount()).toBe(messageIds.length);

    worker = await startWorker();

    await waitFor('all messages to be processed', async () => {
      const count = await harness.prisma.processedMessage.count();
      return count === messageIds.length ? count : null;
    });

    // One tenant, five processed messages.
    expect(await harness.prisma.user.count()).toBe(1);

    const processed = await harness.prisma.processedMessage.findMany({
      orderBy: { messageId: 'asc' },
    });
    expect(processed.map((row) => row.messageId)).toEqual(messageIds);
  });
});
