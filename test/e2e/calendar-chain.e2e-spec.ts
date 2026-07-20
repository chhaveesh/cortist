import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CalendarClient } from '../../src/agents/calendar/google/calendar.port';
import { TelegramSenderService } from '../../src/telegram/outbound/telegram-sender.service';
import { OAuthStateService } from '../../src/oauth/oauth-state.service';
import { WorkerAppModule } from '../../src/worker.module.root';
import { FakeCalendarClient } from '../fakes/fake-calendar.client';
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
 * The Phase 1 → Phase 2 chain, end to end:
 *
 *   Telegram webhook → queue → worker → calendar agent → Telegram reply
 *
 * The pipe test proves gateway → queue → worker. This proves the *agent* runs
 * at the end of it and that the reply comes back to the right chat — the tenant
 * and chat mapping is threaded through four hops and a JSON round trip, and
 * getting it wrong would send a user's calendar details to someone else.
 */
describe('Telegram -> queue -> worker -> calendar agent -> reply (end to end)', () => {
  let harness: TestHarness;
  let worker: INestApplicationContext | undefined;
  let telegram: RecordingTelegramSender;
  let classifier: ScriptedRouteClassifier;
  let calendar: FakeCalendarClient;

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
    await harness.prisma.pendingAction.deleteMany();
    await harness.prisma.oAuthToken.deleteMany();
  });

  /**
   * Boots the real worker composition root with the outbound seams replaced,
   * and hands the fakes back so the test can assert on them.
   */
  async function startAgentWorker() {
    telegram = new RecordingTelegramSender();
    classifier = new ScriptedRouteClassifier();
    calendar = new FakeCalendarClient();

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    })
      .overrideProvider(TelegramSenderService)
      .useValue(telegram)
      .overrideProvider(RouteClassifier)
      .useValue(classifier)
      .overrideProvider(CalendarClient)
      .useValue(calendar)
      .compile();

    return moduleRef.init();
  }

  const post = (body: unknown) =>
    request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set(WEBHOOK_SECRET_HEADER, webhookSecret())
      .send(body as object);

  const update = (
    chatId: number,
    text: string,
    messageId: number,
    telegramUserId = chatId,
  ) => ({
    update_id: 970_000_000 + messageId,
    message: {
      message_id: messageId,
      from: { id: telegramUserId, is_bot: false, first_name: 'Ada' },
      chat: { id: chatId, type: 'private' },
      date: 1_768_000_000,
      text,
    },
  });

  it('delivers a calendar message to the agent and replies to the right chat', async () => {
    const chatId = 606_010_101;

    worker = await startAgentWorker();
    classifier.script({
      route: 'calendar',
      calendarAction: 'create_event',
      title: 'Dentist',
      startTime: '2026-07-21T09:00:00Z',
      endTime: '2026-07-21T10:00:00Z',
    });

    // No calendar connected, so the agent should answer with an OAuth link.
    await post(
      update(chatId, 'book a dentist appointment tomorrow at 9', 70_001),
    ).expect(200);

    const reply = await waitFor('the agent to reply', async () =>
      telegram.sent.length > 0 ? telegram.last : null,
    );

    // The chat the reply goes to must be the chat the message came from.
    expect(reply?.chatId).toBe(String(chatId));
    expect(reply?.text).toContain('/auth/google?state=');

    // And the tenant created by the gateway is the one the agent acted for.
    const user = await harness.prisma.user.findUniqueOrThrow({
      where: { telegramUserId: BigInt(chatId) },
    });
    const state = decodeURIComponent(
      /state=([^\s]+)/.exec(reply?.text ?? '')?.[1] ?? '',
    );
    expect(state.length).toBeGreaterThan(0);
    const stateService = harness.app.get(OAuthStateService);
    expect(stateService.verify(state).tenantId).toBe(user.id);
  });

  it('routes two users concurrently without crossing their replies', async () => {
    // The failure this guards against is the worst kind: one user's calendar
    // details delivered to another user's chat.
    const alice = 606_020_201;
    const bob = 606_020_202;

    worker = await startAgentWorker();
    classifier.script(
      {
        route: 'calendar',
        calendarAction: 'delete_event',
        eventQuery: {
          titleContains: 'meeting',
          approximateStart: '',
          approximateEnd: '',
        },
      },
      {
        route: 'calendar',
        calendarAction: 'create_event',
        title: 'Lunch',
        startTime: '2026-07-21T12:00:00Z',
        endTime: '2026-07-21T13:00:00Z',
      },
    );

    await Promise.all([
      post(update(alice, 'cancel my 3pm meeting', 70_010)).expect(200),
      post(update(bob, 'book lunch tomorrow at noon', 70_011)).expect(200),
    ]);

    await waitFor('both replies', async () =>
      telegram.sent.length >= 2 ? true : null,
    );

    const byChat = new Map(telegram.sent.map((m) => [m.chatId, m.text]));
    expect(byChat.size).toBe(2);
    expect(byChat.has(String(alice))).toBe(true);
    expect(byChat.has(String(bob))).toBe(true);

    // Each user's state parameter must resolve to their own tenant.
    const stateService = harness.app.get(OAuthStateService);
    for (const [chatId, text] of byChat) {
      const state = decodeURIComponent(/state=([^\s]+)/.exec(text)?.[1] ?? '');
      const user = await harness.prisma.user.findUniqueOrThrow({
        where: { telegramUserId: BigInt(chatId) },
      });
      expect(stateService.verify(state).tenantId).toBe(user.id);
    }
  });

  it('passes a non-calendar message through cleanly as a no-op', async () => {
    const chatId = 606_030_301;

    worker = await startAgentWorker();

    await post(
      update(chatId, 'write me a python script to parse csv', 70_020),
    ).expect(200);

    // It still reaches the worker and gets marked processed...
    const processed = await waitFor('the processed marker', async () =>
      harness.prisma.processedMessage.findFirst({
        where: { chatId: BigInt(chatId) },
      }),
    );
    expect(processed).not.toBeNull();

    // ...but costs nothing and says nothing. This is what "clean no-op until
    // the real router exists" has to mean in practice.
    expect(telegram.sent).toEqual([]);
    expect(classifier.callCount).toBe(0);
    expect(calendar.calls).toEqual([]);

    // And the job completed rather than failing or getting stuck.
    await waitFor('the queue to drain', async () =>
      (await harness.queue.getWaitingCount()) === 0 ? true : null,
    );
    expect(await harness.queue.getFailedCount()).toBe(0);
  });
});
