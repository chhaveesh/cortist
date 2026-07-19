import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../config/env.schema';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Deduplicates Telegram deliveries.
 *
 * Telegram re-sends an update if it does not receive a prompt 200, so the same
 * message can arrive several times. `(chatId, messageId)` is Telegram's natural
 * key for a message, and SET NX gives us an atomic claim on it: exactly one
 * caller gets `true`, every retry gets `false`.
 *
 * The key expires after DEDUPE_TTL_SECONDS. Telegram gives up retrying long
 * before then, and the worker's unique constraint on processed_messages backs
 * this up if a delivery somehow arrives after expiry.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('DEDUPE_TTL_SECONDS', { infer: true });
  }

  static key(chatId: string, messageId: number): string {
    return `cortist:dedupe:tg:${chatId}:${messageId}`;
  }

  /**
   * Atomically claim a message for processing.
   *
   * @returns true if the caller now owns this message, false if it was already
   *          claimed by an earlier delivery.
   */
  async claim(chatId: string, messageId: number): Promise<boolean> {
    const key = IdempotencyService.key(chatId, messageId);
    const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');

    const claimed = result === 'OK';
    if (!claimed) {
      this.logger.debug(`Duplicate delivery for ${key} — ignoring`);
    }

    return claimed;
  }

  /**
   * Release a claim. Called when enqueueing fails after a successful claim, so
   * Telegram's retry is able to make progress instead of being deduped away.
   */
  async release(chatId: string, messageId: number): Promise<void> {
    await this.redis.del(IdempotencyService.key(chatId, messageId));
  }
}
