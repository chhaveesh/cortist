import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisOptions } from 'ioredis';
import { REDIS_OPTIONS } from '../redis/redis.module';
import { JOB_ATTEMPTS, JOB_BACKOFF_BASE_MS } from './queue.constants';
import { EnqueueOptions, EnqueueResult, QueueService } from './queue.service';

/**
 * BullMQ-backed implementation of the queue port.
 *
 * Queue handles are created lazily and cached, so adding a new queue in a later
 * phase requires no wiring here.
 */
@Injectable()
export class BullMqQueueService
  extends QueueService
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(BullMqQueueService.name);
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(REDIS_OPTIONS) private readonly redisOptions: RedisOptions,
  ) {
    super();
  }

  private queueFor(name: string): Queue {
    let queue = this.queues.get(name);

    if (!queue) {
      queue = new Queue(name, {
        connection: this.redisOptions,
        defaultJobOptions: {
          // Retry policy, chosen explicitly rather than inherited:
          // 3 total attempts with exponential backoff from a 2s base, so a
          // failing job is retried at ~2s and ~4s and gives up after ~6s. Long
          // enough to ride out a brief dependency blip, short enough that a
          // genuinely broken message surfaces in the failed set quickly.
          attempts: JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: JOB_BACKOFF_BASE_MS },
          // Retain completed jobs briefly so a duplicate arriving moments later
          // still collides on jobId. Failures are kept longer for debugging.
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 24 * 3_600 },
        },
      });
      this.queues.set(name, queue);
    }

    return queue;
  }

  async enqueue<T extends object>(
    queueName: string,
    jobName: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const queue = this.queueFor(queueName);

    // Backstop dedupe. The authoritative check is the Redis SETNX performed by
    // IdempotencyService before we are ever called; this only catches the case
    // where that key has expired but the job itself is still retained.
    if (options.jobId) {
      const state = await queue.getJobState(options.jobId);
      if (state !== 'unknown') {
        this.logger.debug(
          `Job ${options.jobId} already present on ${queueName} (state=${state}) — not re-enqueued`,
        );
        return { jobId: options.jobId, enqueued: false };
      }
    }

    const job = await queue.add(jobName, payload, {
      jobId: options.jobId,
      delay: options.delayMs,
    });

    return { jobId: String(job.id), enqueued: true };
  }

  async countWaiting(queueName: string): Promise<number> {
    return this.queueFor(queueName).getWaitingCount();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
