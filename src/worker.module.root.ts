import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkerModule } from './worker/worker.module';

/**
 * Worker composition root — queue consumption only, no HTTP server.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, RedisModule, WorkerModule],
})
export class WorkerAppModule {}
