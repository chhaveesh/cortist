import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import {
  TelegramMessageJob,
  telegramMessageJobSchema,
} from '../common/contracts/telegram-message.job';
import { RouterService } from '../router/router.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Consumes queued Telegram messages and hands each to the router.
 *
 * The processor knows nothing about agents since Phase 4a — RouterService is
 * the single entry point that classifies once and dispatches. What stays here
 * is the contract validation and the processed marker.
 */
@Injectable()
export class TelegramMessageProcessor {
  private readonly logger = new Logger(TelegramMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: RouterService,
  ) {}

  async process(job: Job): Promise<void> {
    // Re-validate at the consumer boundary. The producer is trusted today, but
    // once multiple services write to this queue a bad payload should fail one
    // job loudly rather than corrupt downstream state quietly.
    const parsed = telegramMessageJobSchema.safeParse(job.data);

    if (!parsed.success) {
      this.logger.error(
        `Job ${job.id} has a payload that does not match any known contract version: ${parsed.error.message}`,
      );
      // Retrying cannot fix a structurally invalid payload — discard so it
      // fails once and lands in the failed set for inspection.
      // Synchronous in BullMQ v5 — it flags the job so no further attempts are
      // scheduled when this handler throws.
      job.discard();
      throw new UnprocessableJobError(`Invalid payload for job ${job.id}`);
    }

    await this.handle(parsed.data);
  }

  private async handle(payload: TelegramMessageJob): Promise<void> {
    this.logger.log(
      `Processing message ${payload.messageId} from chat ${payload.chatId} ` +
        `for tenant ${payload.tenantId}: ${JSON.stringify(payload.text)}`,
    );

    // Agent first, marker second — the ordering matters.
    //
    // Marker-first would let the P2002 branch below short-circuit a retry and
    // skip the agents entirely, silently dropping the message. Agent-first is
    // safe because CalendarAgentService rethrows only on `rate_limited`, and a
    // rate-limited call never executed — so a retry cannot duplicate an event.
    // Every other agent failure returns an outcome instead of throwing, so it
    // never triggers a BullMQ retry in the first place.
    const outcome = await this.router.handle(payload);
    this.logger.log(
      `Router outcome for message ${payload.messageId}: ${outcome.status}`,
    );

    try {
      await this.prisma.processedMessage.create({
        data: {
          tenantId: payload.tenantId,
          chatId: BigInt(payload.chatId),
          messageId: payload.messageId,
          text: payload.text,
        },
      });
    } catch (error) {
      // P2002 = unique violation on (chat_id, message_id): this message was
      // already processed. Idempotent by design, so treat as success.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.warn(
          `Message ${payload.messageId} in chat ${payload.chatId} was already processed — skipping`,
        );
        return;
      }
      throw error;
    }
  }
}

/** Signals a payload that will never succeed, so retrying is pointless. */
export class UnprocessableJobError extends Error {
  readonly name = 'UnprocessableJobError';
}
