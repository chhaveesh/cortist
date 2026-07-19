import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedUser {
  user: User;
  /** True when this call onboarded a brand-new tenant. */
  created: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find the tenant for a Telegram identity, onboarding one if this is the
   * first message we have ever seen from them.
   *
   * Implemented as an upsert so two concurrent deliveries from the same new
   * user cannot race into a unique-constraint violation. The chat id is
   * refreshed on every message because a user's chat can change (e.g. they
   * start a new conversation with the bot).
   */
  async findOrCreateByTelegramId(
    telegramUserId: bigint,
    telegramChatId: bigint,
  ): Promise<ResolvedUser> {
    const existing = await this.prisma.user.findUnique({
      where: { telegramUserId },
    });

    if (existing) {
      if (existing.telegramChatId !== telegramChatId) {
        const updated = await this.prisma.user.update({
          where: { id: existing.id },
          data: { telegramChatId },
        });
        return { user: updated, created: false };
      }
      return { user: existing, created: false };
    }

    const user = await this.prisma.user.upsert({
      where: { telegramUserId },
      create: { telegramUserId, telegramChatId },
      update: { telegramChatId },
    });

    this.logger.log(
      `Onboarded tenant ${user.id} for Telegram user ${telegramUserId}`,
    );

    return { user, created: true };
  }
}
