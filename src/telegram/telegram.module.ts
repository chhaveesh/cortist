import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { QueueModule } from '../queue/queue.module';
import { UsersModule } from '../users/users.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [UsersModule, IdempotencyModule, QueueModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
