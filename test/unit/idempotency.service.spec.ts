import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let redis: { set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = { set: jest.fn(), del: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(3_600) },
        },
      ],
    }).compile();

    service = moduleRef.get(IdempotencyService);
  });

  it('claims a message with SET NX and the configured TTL', async () => {
    redis.set.mockResolvedValue('OK');

    await expect(service.claim('456', 99)).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledWith(
      'cortist:dedupe:tg:456:99',
      '1',
      'EX',
      3_600,
      'NX',
    );
  });

  it('reports a duplicate when the key already exists', async () => {
    // ioredis returns null when NX prevents the write.
    redis.set.mockResolvedValue(null);

    await expect(service.claim('456', 99)).resolves.toBe(false);
  });

  it('namespaces keys by chat as well as message id', () => {
    // Telegram message ids are only unique within a chat, so the chat id must
    // be part of the key or two chats would dedupe against each other.
    expect(IdempotencyService.key('111', 5)).not.toBe(
      IdempotencyService.key('222', 5),
    );
  });

  it('handles negative chat ids (supergroups and channels)', async () => {
    redis.set.mockResolvedValue('OK');
    await service.claim('-1001234567890', 7);

    expect(redis.set).toHaveBeenCalledWith(
      'cortist:dedupe:tg:-1001234567890:7',
      '1',
      'EX',
      3_600,
      'NX',
    );
  });

  it('deletes the key on release', async () => {
    redis.del.mockResolvedValue(1);
    await service.release('456', 99);

    expect(redis.del).toHaveBeenCalledWith('cortist:dedupe:tg:456:99');
  });
});
