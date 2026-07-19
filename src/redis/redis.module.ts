import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { Env } from '../config/env.schema';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS');

export function buildRedisOptions(
  config: ConfigService<Env, true>,
): RedisOptions {
  return {
    host: config.get('REDIS_HOST', { infer: true }),
    port: config.get('REDIS_PORT', { infer: true }),
    password: config.get('REDIS_PASSWORD', { infer: true }),
    db: config.get('REDIS_DB', { infer: true }),
    // Required by BullMQ: its blocking commands must not be aborted by
    // ioredis' per-command retry limit.
    maxRetriesPerRequest: null,
  };
}

/**
 * Shares one ioredis connection for direct application use (dedupe keys,
 * health checks). BullMQ deliberately does NOT reuse this client — it needs
 * dedicated connections for its blocking commands.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildRedisOptions(config),
    },
    {
      provide: REDIS_CLIENT,
      inject: [REDIS_OPTIONS],
      useFactory: (options: RedisOptions) => new Redis(options),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_OPTIONS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
