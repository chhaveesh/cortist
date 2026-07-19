import request from 'supertest';
import {
  MALFORMED_UPDATES,
  buildBotAuthoredUpdate,
  buildNonTextUpdate,
} from '../fixtures/telegram-update.fixture';
import {
  TestHarness,
  WEBHOOK_PATH,
  WEBHOOK_SECRET_HEADER,
  createHarness,
  destroyHarness,
  resetState,
  webhookSecret,
} from '../harness';

describe('Malformed and non-actionable payloads (integration)', () => {
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

  it.each(MALFORMED_UPDATES)(
    'rejects $name with a 4xx and enqueues nothing',
    async ({ body }) => {
      const response = await post(body);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);

      expect(await harness.queue.getWaitingCount()).toBe(0);
      expect(await harness.prisma.user.count()).toBe(0);
    },
  );

  it('returns a structured validation error body', async () => {
    const response = await post({ update_id: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Payload validation failed');
    expect(Array.isArray(response.body.errors)).toBe(true);
    expect(response.body.errors[0]).toHaveProperty('path');
    expect(response.body.errors[0]).toHaveProperty('message');
  });

  /**
   * Schema-valid but nothing to route. These must be acknowledged with a 200:
   * a 4xx would make Telegram retry an update we will never act on.
   */
  it('acknowledges a non-text message without enqueuing', async () => {
    const response = await post(buildNonTextUpdate());

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ignored');
    expect(await harness.queue.getWaitingCount()).toBe(0);
    expect(await harness.prisma.user.count()).toBe(0);
  });

  it('acknowledges a bot-authored message without enqueuing', async () => {
    const response = await post(buildBotAuthoredUpdate());

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ignored');
    expect(await harness.queue.getWaitingCount()).toBe(0);
    expect(await harness.prisma.user.count()).toBe(0);
  });
});
