import request from 'supertest';
import {
  TELEGRAM_MESSAGE_JOB,
  telegramMessageJobSchema,
} from '../../src/common/contracts/telegram-message.job';
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

describe('Telegram webhook ingestion (integration)', () => {
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

  it('accepts a valid update, creates the tenant, and enqueues one job', async () => {
    const telegramUserId = 555_000_111;
    const chatId = 555_000_111;
    const messageId = 9001;
    const text = 'Remind me to file expenses on Friday';

    const startedAt = Date.now();
    const response = await post(
      buildTelegramUpdate({ telegramUserId, chatId, messageId, text }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, status: 'enqueued' });

    // The handler must stay thin — Telegram retries anything slow.
    expect(elapsedMs).toBeLessThan(2_000);

    // --- the user row -------------------------------------------------
    const users = await harness.prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0].telegramUserId).toBe(BigInt(telegramUserId));
    expect(users[0].telegramChatId).toBe(BigInt(chatId));

    // --- the queued job -----------------------------------------------
    const jobs = await harness.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    expect(job.name).toBe(TELEGRAM_MESSAGE_JOB);
    expect(job.id).toBe(`tg:${chatId}:${messageId}`);

    // The payload must satisfy the published contract exactly.
    const parsed = telegramMessageJobSchema.safeParse(job.data);
    expect(parsed.success).toBe(true);

    expect(job.data).toMatchObject({
      jobType: TELEGRAM_MESSAGE_JOB,
      version: 1,
      tenantId: users[0].id,
      telegramUserId: String(telegramUserId),
      chatId: String(chatId),
      messageId,
      text,
    });
    expect(new Date(job.data.receivedAt).getTime()).not.toBeNaN();
  });

  it('reuses the existing tenant for a second message from the same user', async () => {
    const telegramUserId = 555_000_222;

    await post(
      buildTelegramUpdate({
        telegramUserId,
        chatId: telegramUserId,
        messageId: 1,
      }),
    ).expect(200);
    await post(
      buildTelegramUpdate({
        telegramUserId,
        chatId: telegramUserId,
        messageId: 2,
      }),
    ).expect(200);

    const users = await harness.prisma.user.findMany();
    expect(users).toHaveLength(1);

    const jobs = await harness.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(2);
    // Both jobs carry the same tenant id.
    expect(new Set(jobs.map((job) => job.data.tenantId)).size).toBe(1);
  });

  it('rejects a request with a missing or wrong secret token', async () => {
    const update = buildTelegramUpdate({ messageId: 7001 });

    await request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .send(update)
      .expect(401);

    await request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set(WEBHOOK_SECRET_HEADER, 'not-the-secret')
      .send(update)
      .expect(401);

    expect(await harness.queue.getWaitingCount()).toBe(0);
    expect(await harness.prisma.user.count()).toBe(0);
  });
});
