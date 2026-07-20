import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { RouteName } from '../intent/route-intent.schema';

export interface PendingClarification {
  originalText: string;
  between: [RouteName, RouteName];
  attempts: number;
}

/**
 * The routing question a user has not answered yet.
 *
 * Deliberately separate from Phase 2's PendingActionService. That one guards a
 * destructive calendar action; this one only decides which agent a message
 * belongs to. Sharing a table would make a bare "yes" ambiguous between
 * "delete the event" and "the calendar one" — precisely the confusion this
 * exists to remove.
 */
@Injectable()
export class PendingClarificationService {
  private readonly logger = new Logger(PendingClarificationService.name);
  private readonly ttlSeconds: number;

  /**
   * How many times we will ask before giving up.
   *
   * One. A second unclear answer means the question is not landing, and asking
   * again is more annoying than admitting we cannot help — the user has now
   * spent three messages getting nowhere.
   */
  static readonly MAX_ATTEMPTS = 1;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('CLARIFICATION_TTL_SECONDS', { infer: true });
  }

  /** Record a question, superseding any earlier unanswered one. */
  async set(
    tenantId: string,
    originalText: string,
    between: [RouteName, RouteName],
    attempts = 1,
    now = new Date(),
  ): Promise<void> {
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    await this.prisma.pendingClarification.upsert({
      where: { userId: tenantId },
      create: {
        userId: tenantId,
        originalText,
        routeA: between[0],
        routeB: between[1],
        attempts,
        expiresAt,
      },
      update: {
        originalText,
        routeA: between[0],
        routeB: between[1],
        attempts,
        expiresAt,
      },
    });
  }

  /**
   * Read without consuming. Expiry is enforced here rather than by a sweeper,
   * so a delayed cleanup can never resurrect a stale question.
   */
  async get(
    tenantId: string,
    now = new Date(),
  ): Promise<PendingClarification | null> {
    const row = await this.prisma.pendingClarification.findUnique({
      where: { userId: tenantId },
    });

    if (!row) return null;

    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.clear(tenantId);
      return null;
    }

    return {
      originalText: row.originalText,
      between: [row.routeA as RouteName, row.routeB as RouteName],
      attempts: row.attempts,
    };
  }

  /**
   * Atomically take the pending question.
   *
   * Same reasoning as PendingActionService.claim (§33): read-then-delete is a
   * check-then-act race, and two concurrent replies would both resolve it.
   * `DELETE … RETURNING` makes exactly one caller the winner.
   */
  async claim(
    tenantId: string,
    now = new Date(),
  ): Promise<PendingClarification | null> {
    let row;
    try {
      row = await this.prisma.pendingClarification.delete({
        where: { userId: tenantId },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      throw error;
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      this.logger.debug(`Claimed an expired clarification for ${tenantId}`);
      return null;
    }

    return {
      originalText: row.originalText,
      between: [row.routeA as RouteName, row.routeB as RouteName],
      attempts: row.attempts,
    };
  }

  async clear(tenantId: string): Promise<void> {
    await this.prisma.pendingClarification.deleteMany({
      where: { userId: tenantId },
    });
  }
}
