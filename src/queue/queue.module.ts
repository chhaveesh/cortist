import { Module } from '@nestjs/common';
import { BullMqQueueService } from './bullmq-queue.service';
import { QueueService } from './queue.service';

/**
 * Binds the queue port to its BullMQ adapter.
 *
 * To move to SQS: add SqsQueueService implementing QueueService and switch the
 * `useClass` below (or select on config). Nothing else in the app changes.
 */
@Module({
  providers: [{ provide: QueueService, useClass: BullMqQueueService }],
  exports: [QueueService],
})
export class QueueModule {}
