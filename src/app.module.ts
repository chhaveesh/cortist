import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TelegramModule } from './telegram/telegram.module';

/**
 * Gateway composition root — HTTP ingestion only.
 *
 * Note what is absent: WorkerModule. The gateway must never consume from the
 * queue, or the two would scale together.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    TelegramModule,
    HealthModule,
  ],
})
export class AppModule {}
