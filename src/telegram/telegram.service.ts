import { Injectable, Logger } from '@nestjs/common';
import {
  CURRENT_TELEGRAM_MESSAGE_JOB_VERSION,
  TELEGRAM_MESSAGE_JOB,
  TelegramMessageJobV1,
  telegramMessageJobId,
} from '../common/contracts/telegram-message.job';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { UsersService } from '../users/users.service';
import {
  ActionableMessage,
  TelegramUpdate,
  extractActionableMessage,
} from './telegram.schema';

/** Why an update did not result in a queued job. Surfaced for tests and metrics. */
export type IngestOutcome =
  | {
      status: 'enqueued';
      jobId: string;
      tenantId: string;
      createdUser: boolean;
    }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: 'not_an_actionable_message' };

/**
 * The ingestion path. Intentionally short: resolve identity, claim the message,
 * enqueue, return. Anything that could be slow or fail in interesting ways
 * belongs in the worker, not here — Telegram retries anything it does not get a
 * fast 200 for.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly users: UsersService,
    private readonly idempotency: IdempotencyService,
    private readonly queue: QueueService,
  ) {}

  async ingestUpdate(update: TelegramUpdate): Promise<IngestOutcome> {
    const message = extractActionableMessage(update);

    if (!message) {
      this.logger.debug(
        `Update ${update.update_id} carries no actionable text message — acknowledged without enqueue`,
      );
      return { status: 'ignored', reason: 'not_an_actionable_message' };
    }

    const chatId = message.chatId.toString();

    // Claim before doing any work, so concurrent retries collapse to one.
    const claimed = await this.idempotency.claim(chatId, message.messageId);
    if (!claimed) {
      return { status: 'duplicate' };
    }

    try {
      const { user, created } = await this.users.findOrCreateByTelegramId(
        message.telegramUserId,
        message.chatId,
      );

      const payload = this.buildJobPayload(message, user.id, new Date());

      const result = await this.queue.enqueue(
        QUEUES.TELEGRAM_MESSAGES,
        TELEGRAM_MESSAGE_JOB,
        payload,
        { jobId: telegramMessageJobId(chatId, message.messageId) },
      );

      this.logger.log(
        `Enqueued ${result.jobId} for tenant ${user.id} (new=${created})`,
      );

      return {
        status: 'enqueued',
        jobId: result.jobId,
        tenantId: user.id,
        createdUser: created,
      };
    } catch (error) {
      // Give up the claim so Telegram's retry can succeed rather than being
      // silently deduped into a black hole.
      await this.idempotency.release(chatId, message.messageId);
      throw error;
    }
  }

  /**
   * Builds the versioned queue contract. Kept separate and pure so it can be
   * unit-tested without Redis or Postgres.
   */
  buildJobPayload(
    message: ActionableMessage,
    tenantId: string,
    receivedAt: Date,
  ): TelegramMessageJobV1 {
    return {
      jobType: TELEGRAM_MESSAGE_JOB,
      version: CURRENT_TELEGRAM_MESSAGE_JOB_VERSION,
      tenantId,
      telegramUserId: message.telegramUserId.toString(),
      chatId: message.chatId.toString(),
      messageId: message.messageId,
      text: message.text,
      receivedAt: receivedAt.toISOString(),
    };
  }
}
