import request from 'supertest';
import { buildTelegramUpdate } from '../fixtures/telegram-update.fixture';
import {
  TestHarness,
  WEBHOOK_PATH,
  WEBHOOK_SECRET_HEADER,
  createHarness,
  destroyHarness,
  resetState,
  webhookSecret,
} from '../harness';

/**
 * Telegram re-delivers an update until it gets a prompt 200, so the same
 * message id arriving twice is normal traffic, not an error.
 */
describe('Duplicate webhook delivery (integration)', () => {
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

  it('enqueues one job when the same update is delivered twice', async () => {
    const update = buildTelegramUpdate({
      telegramUserId: 777_000_111,
      chatId: 777_000_111,
      messageId: 31337,
    });

    const first = await post(update);
    const second = await post(update);

    // Both are acknowledged — a retry must never be answered with an error.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.status).toBe('enqueued');
    expect(second.body.status).toBe('duplicate');

    const jobs = await harness.queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);

    // And no duplicate tenant.
    expect(await harness.prisma.user.count()).toBe(1);
  });

  it('collapses concurrent duplicate deliveries to a single job', async () => {
    const update = buildTelegramUpdate({
      telegramUserId: 777_000_222,
      chatId: 777_000_222,
      messageId: 42_424,
    });

    // Telegram can have several retries in flight at once; the SETNX claim is
    // what makes this safe.
    const responses = await Promise.all([
      post(update),
      post(update),
      post(update),
      post(update),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    const enqueued = responses.filter((r) => r.body.status === 'enqueued');
    expect(enqueued).toHaveLength(1);

    const jobs = await harness.queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
    ]);
    expect(jobs).toHaveLength(1);
    expect(await harness.prisma.user.count()).toBe(1);
  });

  it('treats a different message id from the same user as new work', async () => {
    const base = {
      telegramUserId: 777_000_333,
      chatId: 777_000_333,
    };

    await post(buildTelegramUpdate({ ...base, messageId: 100 })).expect(200);
    await post(buildTelegramUpdate({ ...base, messageId: 101 })).expect(200);

    const jobs = await harness.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(2);
  });
});
