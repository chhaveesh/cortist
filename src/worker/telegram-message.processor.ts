import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { CalendarAgentService } from '../agents/calendar/calendar-agent.service';
import { RagAgentService } from '../agents/rag/rag-agent.service';
import {
  TelegramMessageJob,
  attachmentOf,
  telegramMessageJobSchema,
} from '../common/contracts/telegram-message.job';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Consumes queued Telegram messages and dispatches them to the calendar agent.
 *
 * There is no general router yet — every message goes to the one agent that
 * exists, which classifies it and ignores anything non-calendar. A later phase
 * replaces this single call with routing across agents; the validation and
 * marker scaffolding around it stays.
 */
@Injectable()
export class TelegramMessageProcessor {
  private readonly logger = new Logger(TelegramMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendarAgent: CalendarAgentService,
    private readonly ragAgent: RagAgentService,
  ) {}

  /**
   * Offers the message to each agent in turn until one claims it.
   *
   * This is NOT the intent router — it is the honest interim stand-in for one.
   * Each agent classifies independently and returns `skipped` when the message
   * is not its business, so ordering only decides who gets first refusal.
   *
   * An attachment goes straight to RAG: the calendar agent has nothing to do
   * with a PDF, and its pre-filter would spend a classification deciding that.
   *
   * The real router replaces this with a single up-front classification, which
   * is what stops the cost growing linearly with the number of agents.
   */
  private async dispatch(payload: TelegramMessageJob): Promise<void> {
    if (attachmentOf(payload)) {
      const outcome = await this.ragAgent.handle(payload);
      this.logger.log(
        `RAG agent handled attachment for message ${payload.messageId}: ${outcome.status}`,
      );
      return;
    }

    const calendar = await this.calendarAgent.handle(payload);
    if (calendar.status !== 'skipped') {
      this.logger.log(
        `Calendar agent handled message ${payload.messageId}: ${calendar.status}`,
      );
      return;
    }

    const rag = await this.ragAgent.handle(payload);
    this.logger.log(
      `RAG agent outcome for message ${payload.messageId}: ${rag.status}`,
    );
  }

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
    await this.dispatch(payload);

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
