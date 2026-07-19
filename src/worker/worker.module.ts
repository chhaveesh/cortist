import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { RedisOptions } from 'ioredis';
import { Env } from '../config/env.schema';
import { JOB_ATTEMPTS, QUEUES } from '../queue/queue.constants';
import { REDIS_OPTIONS } from '../redis/redis.module';
import { TelegramMessageProcessor } from './telegram-message.processor';

/**
 * Owns the BullMQ Worker lifecycle.
 *
 * This module is only loaded by the worker entrypoint (`worker.ts`), never by
 * the gateway — that is what keeps the two processes independently scalable.
 */
@Injectable()
export class TelegramMessageWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramMessageWorker.name);
  private worker?: Worker;

  constructor(
    @Inject(REDIS_OPTIONS) private readonly redisOptions: RedisOptions,
    private readonly config: ConfigService<Env, true>,
    private readonly processor: TelegramMessageProcessor,
  ) {}

  onModuleInit(): void {
    const concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });

    this.worker = new Worker(
      QUEUES.TELEGRAM_MESSAGES,
      async (job: Job) => this.processor.process(job),
      { connection: this.redisOptions, concurrency },
    );

    this.worker.on('failed', (job, error) => {
      const attempts = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? JOB_ATTEMPTS;

      if (attempts >= maxAttempts) {
        // Terminal. The job is now in BullMQ's failed set — retained, visible,
        // and replayable — not silently dropped.
        this.logger.error(
          `Job ${job?.id} exhausted all ${maxAttempts} attempts and moved to ` +
            `the failed set: ${error.message}`,
          error.stack,
        );
      } else {
        this.logger.warn(
          `Job ${job?.id} failed on attempt ${attempts}/${maxAttempts}, ` +
            `will retry: ${error.message}`,
        );
      }
    });

    this.worker.on('error', (error) => {
      this.logger.error(`Worker error: ${error.message}`, error.stack);
    });

    this.logger.log(
      `Worker listening on "${QUEUES.TELEGRAM_MESSAGES}" (concurrency=${concurrency})`,
    );
  }

  /**
   * Nest invokes this on SIGTERM/SIGINT (see `enableShutdownHooks`).
   *
   * `worker.close()` stops fetching new jobs immediately and resolves once
   * in-flight jobs finish. We bound that wait: if a job outlives the timeout we
   * stop waiting and let the process exit. The job is NOT lost — it stays in
   * BullMQ's active set with no live owner, and is recovered as a stalled job
   * by the next worker, then retried under the normal attempts/backoff policy.
   * Blocking forever would instead guarantee a SIGKILL from the orchestrator,
   * which is strictly worse.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.worker) return;

    const timeoutMs = this.config.get('WORKER_SHUTDOWN_TIMEOUT_MS', {
      infer: true,
    });

    this.logger.log(
      `Shutdown (${signal ?? 'manual'}): no longer accepting jobs, ` +
        `waiting up to ${timeoutMs}ms for in-flight work`,
    );

    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;

    const drained = await Promise.race([
      this.worker.close().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);

    if (timer) clearTimeout(timer);

    if (drained) {
      this.logger.log(
        `Shutdown complete: in-flight jobs finished in ${Date.now() - startedAt}ms`,
      );
    } else {
      this.logger.warn(
        `Shutdown forced after ${timeoutMs}ms — in-flight jobs were abandoned ` +
          'and will be recovered as stalled jobs and retried by another worker',
      );
      // Stop waiting, but ask BullMQ to release its Redis connections so the
      // stalled-job checker can reclaim the work promptly.
      void this.worker.close(true).catch(() => undefined);
    }

    this.worker = undefined;
  }
}

@Module({
  providers: [TelegramMessageProcessor, TelegramMessageWorker],
  exports: [TelegramMessageProcessor],
})
export class WorkerModule {}
