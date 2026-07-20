import { Test } from '@nestjs/testing';
import { User } from '@prisma/client';
import {
  TELEGRAM_MESSAGE_JOB,
  telegramMessageJobSchema,
} from '../../src/common/contracts/telegram-message.job';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { QUEUES } from '../../src/queue/queue.constants';
import { QueueService } from '../../src/queue/queue.service';
import { TelegramService } from '../../src/telegram/telegram.service';
import {
  ActionableMessage,
  telegramUpdateSchema,
} from '../../src/telegram/telegram.schema';
import { UsersService } from '../../src/users/users.service';
import {
  buildNonTextUpdate,
  buildTelegramUpdate,
} from '../fixtures/telegram-update.fixture';

const TENANT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: TENANT_ID,
    telegramUserId: 123n,
    telegramChatId: 456n,
    timeZone: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('TelegramService', () => {
  let service: TelegramService;
  let users: jest.Mocked<Pick<UsersService, 'findOrCreateByTelegramId'>>;
  let idempotency: jest.Mocked<Pick<IdempotencyService, 'claim' | 'release'>>;
  let queue: jest.Mocked<Pick<QueueService, 'enqueue' | 'countWaiting'>>;

  beforeEach(async () => {
    users = { findOrCreateByTelegramId: jest.fn() };
    idempotency = { claim: jest.fn(), release: jest.fn() };
    queue = { enqueue: jest.fn(), countWaiting: jest.fn() };

    users.findOrCreateByTelegramId.mockResolvedValue({
      user: fakeUser(),
      created: true,
    });
    idempotency.claim.mockResolvedValue(true);
    idempotency.release.mockResolvedValue(undefined);
    queue.enqueue.mockResolvedValue({ jobId: 'tg:456:1', enqueued: true });

    const moduleRef = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: UsersService, useValue: users },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: QueueService, useValue: queue },
      ],
    }).compile();

    service = moduleRef.get(TelegramService);
  });

  describe('buildJobPayload', () => {
    const message: ActionableMessage = {
      telegramUserId: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
      chatId: -1_001_234_567_890n, // supergroup ids are negative
      messageId: 77,
      text: 'hello world',
    };

    it('produces a payload matching the published contract', () => {
      const payload = service.buildJobPayload(
        message,
        TENANT_ID,
        new Date('2026-07-19T12:00:00.000Z'),
      );

      expect(payload).toEqual({
        jobType: TELEGRAM_MESSAGE_JOB,
        // v2 since Phase 3 — see the contract file for why documents forced a
        // new version rather than an optional field on v1.
        version: 2,
        tenantId: TENANT_ID,
        telegramUserId: '9007199254740993',
        chatId: '-1001234567890',
        messageId: 77,
        text: 'hello world',
        receivedAt: '2026-07-19T12:00:00.000Z',
      });

      expect(telegramMessageJobSchema.safeParse(payload).success).toBe(true);
    });

    it('omits the attachment field entirely for a plain text message', () => {
      const payload = service.buildJobPayload(message, TENANT_ID, new Date());
      expect('attachment' in payload).toBe(false);
    });

    it('carries a file reference, never the file bytes', () => {
      // A 20MB PDF has no business in a Redis job payload; the worker fetches
      // it from Telegram when it is ready to process it.
      const withFile: ActionableMessage = {
        ...message,
        attachment: {
          fileId: 'BQACAgIAAxkBAAI',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileSize: 512_000,
        },
      };

      const payload = service.buildJobPayload(withFile, TENANT_ID, new Date());

      expect(payload.attachment).toEqual({
        fileId: 'BQACAgIAAxkBAAI',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSize: 512_000,
      });
      expect(JSON.stringify(payload).length).toBeLessThan(1000);
    });

    it('encodes 64-bit ids as strings so JSON cannot lose precision', () => {
      const payload = service.buildJobPayload(message, TENANT_ID, new Date());
      const roundTripped = JSON.parse(JSON.stringify(payload));

      expect(roundTripped.telegramUserId).toBe('9007199254740993');
      expect(typeof roundTripped.telegramUserId).toBe('string');
    });
  });

  describe('ingestUpdate', () => {
    it('claims, resolves the tenant, and enqueues on the happy path', async () => {
      const update = telegramUpdateSchema.parse(
        buildTelegramUpdate({ chatId: 456, messageId: 1, telegramUserId: 123 }),
      );

      const outcome = await service.ingestUpdate(update);

      expect(outcome).toEqual({
        status: 'enqueued',
        jobId: 'tg:456:1',
        tenantId: TENANT_ID,
        createdUser: true,
      });

      expect(idempotency.claim).toHaveBeenCalledWith('456', 1);
      expect(users.findOrCreateByTelegramId).toHaveBeenCalledWith(123n, 456n);
      expect(queue.enqueue).toHaveBeenCalledWith(
        QUEUES.TELEGRAM_MESSAGES,
        TELEGRAM_MESSAGE_JOB,
        expect.objectContaining({ version: 2, tenantId: TENANT_ID }),
        { jobId: 'tg:456:1' },
      );
    });

    it('claims BEFORE touching the database, so retries do no work', async () => {
      const callOrder: string[] = [];
      idempotency.claim.mockImplementation(async () => {
        callOrder.push('claim');
        return true;
      });
      users.findOrCreateByTelegramId.mockImplementation(async () => {
        callOrder.push('user');
        return { user: fakeUser(), created: false };
      });

      await service.ingestUpdate(
        telegramUpdateSchema.parse(buildTelegramUpdate()),
      );

      expect(callOrder).toEqual(['claim', 'user']);
    });

    it('short-circuits a duplicate without enqueueing or writing', async () => {
      idempotency.claim.mockResolvedValue(false);

      const outcome = await service.ingestUpdate(
        telegramUpdateSchema.parse(buildTelegramUpdate()),
      );

      expect(outcome).toEqual({ status: 'duplicate' });
      expect(users.findOrCreateByTelegramId).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('ignores an update with nothing actionable in it', async () => {
      const outcome = await service.ingestUpdate(
        telegramUpdateSchema.parse(buildNonTextUpdate()),
      );

      expect(outcome).toEqual({
        status: 'ignored',
        reason: 'not_an_actionable_message',
      });
      expect(idempotency.claim).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('releases the claim when enqueueing fails, so a retry can succeed', async () => {
      queue.enqueue.mockRejectedValue(new Error('redis is down'));

      await expect(
        service.ingestUpdate(
          telegramUpdateSchema.parse(
            buildTelegramUpdate({ chatId: 456, messageId: 1 }),
          ),
        ),
      ).rejects.toThrow('redis is down');

      expect(idempotency.release).toHaveBeenCalledWith('456', 1);
    });

    it('releases the claim when the database write fails', async () => {
      users.findOrCreateByTelegramId.mockRejectedValue(new Error('pg is down'));

      await expect(
        service.ingestUpdate(
          telegramUpdateSchema.parse(
            buildTelegramUpdate({ chatId: 456, messageId: 1 }),
          ),
        ),
      ).rejects.toThrow('pg is down');

      expect(idempotency.release).toHaveBeenCalledWith('456', 1);
    });
  });
});
