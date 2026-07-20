import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Env } from '../../../config/env.schema';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * A destructive action, fully resolved and ready to execute, waiting on the
 * user's "yes".
 *
 * The event id is resolved BEFORE the record is written, not after
 * confirmation. That matters: if we stored only the user's words and resolved
 * them on "yes", a calendar that changed in between could make "yes" delete a
 * different event than the one described in the confirmation prompt.
 */
export const pendingDeleteSchema = z.object({
  type: z.literal('delete_event'),
  eventId: z.string(),
  eventTitle: z.string(),
  eventStart: z.string(),
});

export const pendingRescheduleSchema = z.object({
  type: z.literal('reschedule_event'),
  eventId: z.string(),
  eventTitle: z.string(),
  originalStart: z.string(),
  newStart: z.string(),
  newEnd: z.string(),
  timeZone: z.string(),
});

export const pendingActionPayloadSchema = z.discriminatedUnion('type', [
  pendingDeleteSchema,
  pendingRescheduleSchema,
]);

export type PendingActionPayload = z.infer<typeof pendingActionPayloadSchema>;

@Injectable()
export class PendingActionService {
  private readonly logger = new Logger(PendingActionService.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('PENDING_ACTION_TTL_SECONDS', { infer: true });
  }

  /**
   * Record an action awaiting confirmation, replacing any previous one.
   *
   * Replacement rather than rejection is deliberate: if a user asks to delete
   * A, then changes their mind and asks to delete B, their "yes" clearly refers
   * to B. Keeping A pending would make the confirmation ambiguous.
   */
  async set(
    tenantId: string,
    payload: PendingActionPayload,
    now = new Date(),
  ): Promise<void> {
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    await this.prisma.pendingAction.upsert({
      where: { userId: tenantId },
      create: {
        userId: tenantId,
        actionType: payload.type,
        payload,
        expiresAt,
      },
      update: { actionType: payload.type, payload, expiresAt },
    });

    this.logger.debug(
      `Pending ${payload.type} for tenant ${tenantId}, expires ${expiresAt.toISOString()}`,
    );
  }

  /**
   * Read the outstanding action, if any.
   *
   * Expiry is enforced on read rather than by a sweeper: the row's presence is
   * never trusted on its own, so a delayed cleanup can never resurrect a stale
   * confirmation. Expired rows are deleted opportunistically here.
   */
  async get(
    tenantId: string,
    now = new Date(),
  ): Promise<PendingActionPayload | null> {
    const row = await this.prisma.pendingAction.findUnique({
      where: { userId: tenantId },
    });

    if (!row) return null;

    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.clear(tenantId);
      this.logger.debug(`Discarded expired pending action for ${tenantId}`);
      return null;
    }

    const parsed = pendingActionPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      // Written by an older build, or hand-edited. Unexecutable either way.
      this.logger.error(
        `Pending action for ${tenantId} failed validation: ${parsed.error.message}`,
      );
      await this.clear(tenantId);
      return null;
    }

    return parsed.data;
  }

  /**
   * Atomically take ownership of the pending action: remove the row and return
   * what it held, or null if there was nothing (or someone else got there
   * first).
   *
   * This is the method to use before *executing* a confirmed action. `get()`
   * followed by `clear()` is a check-then-act race — two concurrent "yes"
   * replies (a double-tap, or a retried job) both read the row before either
   * cleared it, and both went on to delete. Postgres `DELETE … RETURNING` makes
   * exactly one caller the winner.
   */
  async claim(
    tenantId: string,
    now = new Date(),
  ): Promise<PendingActionPayload | null> {
    let row;
    try {
      row = await this.prisma.pendingAction.delete({
        where: { userId: tenantId },
      });
    } catch (error) {
      // P2025 = no row matched: nothing pending, or another caller won.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      throw error;
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      this.logger.debug(`Claimed an already-expired action for ${tenantId}`);
      return null;
    }

    const parsed = pendingActionPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      this.logger.error(
        `Claimed pending action for ${tenantId} failed validation: ${parsed.error.message}`,
      );
      return null;
    }

    return parsed.data;
  }

  async clear(tenantId: string): Promise<void> {
    await this.prisma.pendingAction.deleteMany({ where: { userId: tenantId } });
  }
}
