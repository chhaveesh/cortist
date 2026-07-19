import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { registerBigIntJson } from '../src/common/bigint-json';
import { PrismaService } from '../src/prisma/prisma.service';
import { QUEUES } from '../src/queue/queue.constants';
import { WorkerAppModule } from '../src/worker.module.root';

registerBigIntJson();

export const WEBHOOK_PATH = '/telegram/webhook';
export const WEBHOOK_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export function webhookSecret(): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET is unset — is test/setup-env.ts loading .env.test?',
    );
  }
  return secret;
}

export function redisConnectionOptions() {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 56379),
    maxRetriesPerRequest: null,
  };
}

export interface TestHarness {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  /** Direct queue handle for asserting on enqueued jobs. */
  queue: Queue;
}

/**
 * Boots the gateway in-process against the containers from
 * docker-compose.test.yml, plus standalone Redis and Queue handles so tests can
 * inspect the pipe from the outside.
 */
export async function createHarness(): Promise<TestHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = new Redis(redisConnectionOptions());
  const queue = new Queue(QUEUES.TELEGRAM_MESSAGES, {
    connection: redisConnectionOptions(),
  });

  return { app, prisma, redis, queue };
}

export async function destroyHarness(harness: TestHarness): Promise<void> {
  await harness.queue.close();
  await harness.redis.quit();
  await harness.app.close();
}

/**
 * Returns the environment to a known-clean state between tests: no rows, no
 * jobs, no dedupe keys. Without this, the duplicate-delivery test would be
 * order-dependent.
 */
export async function resetState(harness: TestHarness): Promise<void> {
  await harness.queue.obliterate({ force: true });
  await harness.redis.flushdb();
  await harness.prisma.processedMessage.deleteMany();
  await harness.prisma.user.deleteMany();
}

/**
 * Boots the worker from `WorkerAppModule` — the same composition root
 * `dist/worker.js` uses in production — so tests exercise the real consumer,
 * not a stand-in. A TestingModule is itself an application context, and
 * `init()` fires the OnModuleInit hook that starts the BullMQ worker.
 */
export async function startWorker(): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerAppModule],
  }).compile();

  return moduleRef.init();
}

/** Polls until `check` returns something non-nullish, or throws on timeout. */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null && result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}
