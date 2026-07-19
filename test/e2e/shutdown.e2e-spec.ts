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
 * Graceful shutdown.
 *
 * ECS Fargate sends SIGTERM on every deploy and scale-down. Nest's
 * `enableShutdownHooks()` turns that signal into the `onApplicationShutdown`
 * call these tests invoke via `app.close()` — so exercising close() exercises
 * the real SIGTERM path, without the flakiness of signalling a child process.
 *
 * The contract being verified: on shutdown the worker stops taking new jobs,
 * finishes what it already has, and leaves everything else in a retryable
 * state. Nothing is silently lost.
 */
describe('Worker graceful shutdown (end to end)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
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

  async function enqueue(messageIds: number[], telegramUserId: number) {
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
  }

  it('leaves no job stranded in the active state after shutdown', async () => {
    const messageIds = Array.from({ length: 40 }, (_, i) => 7_000 + i);
    await enqueue(messageIds, 991_000_111);

    const worker = await startWorker();

    // Shut down while the backlog is still draining — this is the interesting
    // case, and the reason for a backlog rather than a single job.
    await waitFor('the worker to start consuming', async () =>
      (await harness.prisma.processedMessage.count()) > 0 ? true : null,
    );

    await worker.close();

    // `active` means "claimed by a worker that no longer exists". Anything left
    // there would be invisible work, recoverable only by the stalled-job
    // checker. After a clean drain there should be none.
    const counts = await harness.queue.getJobCounts(
      'active',
      'waiting',
      'delayed',
      'completed',
      'failed',
    );

    expect(counts.active).toBe(0);
    expect(counts.failed).toBe(0);

    // Every job is accounted for: either done, or still queued for the next
    // worker to pick up.
    const processed = await harness.prisma.processedMessage.count();
    expect(counts.completed).toBe(processed);
    expect(processed + counts.waiting + counts.delayed).toBe(messageIds.length);
  });

  it('stops accepting new work once shutdown has begun', async () => {
    await enqueue([8_001, 8_002], 991_000_222);

    const worker = await startWorker();
    await waitFor('the queue to drain', async () =>
      (await harness.prisma.processedMessage.count()) === 2 ? true : null,
    );

    await worker.close();

    // A job arriving after shutdown must sit untouched — the closed worker
    // must not reach back into the queue.
    await enqueue([8_003], 991_000_222);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(await harness.prisma.processedMessage.count()).toBe(2);
    expect(await harness.queue.getWaitingCount()).toBe(1);
  });

  it('a restarted worker picks up what the previous one left behind', async () => {
    // The full deploy cycle: worker dies mid-backlog, replacement takes over.
    const messageIds = Array.from({ length: 30 }, (_, i) => 9_000 + i);
    await enqueue(messageIds, 991_000_333);

    const first = await startWorker();
    await waitFor('the first worker to start consuming', async () =>
      (await harness.prisma.processedMessage.count()) > 0 ? true : null,
    );
    await first.close();

    const processedByFirst = await harness.prisma.processedMessage.count();

    const second = await startWorker();
    try {
      await waitFor('the replacement worker to finish the backlog', async () =>
        (await harness.prisma.processedMessage.count()) === messageIds.length
          ? true
          : null,
      );
    } finally {
      await second.close();
    }

    expect(processedByFirst).toBeLessThanOrEqual(messageIds.length);
    expect(await harness.prisma.processedMessage.count()).toBe(
      messageIds.length,
    );

    // No duplicate processing across the handover.
    const rows = await harness.prisma.processedMessage.findMany({
      orderBy: { messageId: 'asc' },
    });
    expect(rows.map((row) => row.messageId)).toEqual(messageIds);
  });
});
