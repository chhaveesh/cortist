import {
  CURRENT_TELEGRAM_MESSAGE_JOB_VERSION,
  TELEGRAM_MESSAGE_JOB,
  telegramMessageJobId,
} from '../../src/common/contracts/telegram-message.job';
import {
  JOB_ATTEMPTS,
  JOB_BACKOFF_BASE_MS,
  QUEUES,
} from '../../src/queue/queue.constants';
import { QueueService } from '../../src/queue/queue.service';
import {
  TestHarness,
  createHarness,
  destroyHarness,
  resetState,
  startWorker,
  waitFor,
} from '../harness';

/**
 * Retry and failure policy.
 *
 * A job that keeps failing must retry a bounded number of times with growing
 * delays, then come to rest in BullMQ's failed set — visible and replayable,
 * never silently dropped.
 *
 * The failure is induced with a `messageId` that overflows Postgres' INTEGER
 * column. That is a genuine, repeatable infrastructure-level error raised from
 * inside the processor, rather than a mock — so the retry path being tested is
 * the real one.
 */
describe('Job retry and failure policy (end to end)', () => {
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

  const OVERFLOWING_MESSAGE_ID = 2_147_483_648; // INT4 max + 1

  async function enqueueFailingJob(chatId: string) {
    const queue = harness.app.get(QueueService);

    return queue.enqueue(
      QUEUES.TELEGRAM_MESSAGES,
      TELEGRAM_MESSAGE_JOB,
      {
        jobType: TELEGRAM_MESSAGE_JOB,
        version: CURRENT_TELEGRAM_MESSAGE_JOB_VERSION,
        tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        telegramUserId: '123456789',
        chatId,
        messageId: OVERFLOWING_MESSAGE_ID,
        text: 'this job cannot succeed',
        receivedAt: new Date().toISOString(),
      },
      { jobId: telegramMessageJobId(chatId, OVERFLOWING_MESSAGE_ID) },
    );
  }

  it('applies the configured attempts and backoff to every job', async () => {
    // Policy is set once as a queue default, so asserting it on a real enqueued
    // job proves every producer inherits it.
    const queue = harness.app.get(QueueService);
    await queue.enqueue(
      QUEUES.TELEGRAM_MESSAGES,
      TELEGRAM_MESSAGE_JOB,
      {
        jobType: TELEGRAM_MESSAGE_JOB,
        version: CURRENT_TELEGRAM_MESSAGE_JOB_VERSION,
        tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        telegramUserId: '1',
        chatId: '1',
        messageId: 1,
        text: 'hi',
        receivedAt: new Date().toISOString(),
      },
      { jobId: telegramMessageJobId('1', 1) },
    );

    const [job] = await harness.queue.getJobs(['waiting']);

    expect(job.opts.attempts).toBe(JOB_ATTEMPTS);
    expect(job.opts.backoff).toEqual({
      type: 'exponential',
      delay: JOB_BACKOFF_BASE_MS,
    });
  });

  it('retries a failing job, then moves it to the failed set', async () => {
    const chatId = '992000111';
    await enqueueFailingJob(chatId);

    const worker = await startWorker();

    try {
      const failed = await waitFor(
        'the job to exhaust its retries',
        async () => {
          const jobs = await harness.queue.getJobs(['failed']);
          return jobs.length > 0 ? jobs[0] : null;
        },
        // Backoff is ~2s + ~4s, so allow generous headroom.
        30_000,
        250,
      );

      // Every attempt was used — not abandoned early, not retried forever.
      expect(failed.attemptsMade).toBe(JOB_ATTEMPTS);
      expect(failed.failedReason).toBeTruthy();

      // It is retained in the failed set, so it can be inspected and replayed.
      expect(await harness.queue.getFailedCount()).toBe(1);
      expect(await harness.queue.getCompletedCount()).toBe(0);

      // And it genuinely never wrote anything.
      expect(await harness.prisma.processedMessage.count()).toBe(0);
    } finally {
      await worker.close();
    }
  }, 60_000);

  it('backs off between attempts rather than retrying immediately', async () => {
    const chatId = '992000222';
    await enqueueFailingJob(chatId);

    const startedAt = Date.now();
    const worker = await startWorker();

    try {
      const failed = await waitFor(
        'the job to exhaust its retries',
        async () => {
          const jobs = await harness.queue.getJobs(['failed']);
          return jobs.length > 0 ? jobs[0] : null;
        },
        30_000,
        250,
      );

      const elapsed = Date.now() - startedAt;

      // Exponential backoff from a 2s base means waits of ~2s then ~4s. If the
      // policy were lost, all three attempts would burn through in milliseconds.
      const minimumExpected = JOB_BACKOFF_BASE_MS + JOB_BACKOFF_BASE_MS * 2;
      expect(elapsed).toBeGreaterThanOrEqual(minimumExpected * 0.8);
      expect(failed.attemptsMade).toBe(JOB_ATTEMPTS);
    } finally {
      await worker.close();
    }
  }, 60_000);

  it('discards a structurally invalid payload without burning retries', async () => {
    // A payload that can never become valid should fail once, not three times —
    // retrying it is pure waste.
    await harness.queue.add(
      TELEGRAM_MESSAGE_JOB,
      { jobType: TELEGRAM_MESSAGE_JOB, version: 99, garbage: true },
      { jobId: 'tg:bad:1', attempts: JOB_ATTEMPTS },
    );

    const worker = await startWorker();

    try {
      const failed = await waitFor(
        'the invalid job to fail',
        async () => {
          const jobs = await harness.queue.getJobs(['failed']);
          return jobs.length > 0 ? jobs[0] : null;
        },
        15_000,
        200,
      );

      expect(failed.attemptsMade).toBe(1);
      expect(failed.failedReason).toContain('Invalid payload');
    } finally {
      await worker.close();
    }
  }, 30_000);
});
