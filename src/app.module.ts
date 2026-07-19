import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TelegramModule } from './telegram/telegram.module';

/**
 * Gateway composition root — HTTP only: the Telegram webhook, the Google OAuth
 * consent/callback endpoints, and health.
 *
 * Note what is absent: WorkerModule and CalendarAgentModule. The gateway must
 * never consume from the queue or run agent logic, or the two processes would
 * scale together.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    CryptoModule,
    TelegramModule,
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
