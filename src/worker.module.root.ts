import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WorkerModule } from './worker/worker.module';

/**
 * Worker composition root — queue consumption and agent execution, no HTTP.
 *
 * CryptoModule is here because the agent decrypts OAuth tokens to call the
 * Calendar API; AuthModule is not, because serving the consent screen is the
 * gateway's job.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    CryptoModule,
    WorkerModule,
  ],
})
export class WorkerAppModule {}
