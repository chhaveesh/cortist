import { Global, Module } from '@nestjs/common';
import {
  ConfigModule as NestConfigModule,
  ConfigService,
} from '@nestjs/config';
import { Env, validateEnv } from './env.schema';

/**
 * Typed accessor over Nest's ConfigService.
 *
 * `ConfigService<Env, true>` makes `get()` return non-optional values for keys
 * declared in the schema, so callers do not litter the codebase with `!`.
 */
export type TypedConfigService = ConfigService<Env, true>;

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Local runs read .env; in Docker the values arrive as real env vars.
      envFilePath: ['.env'],
    }),
  ],
  exports: [NestConfigModule],
})
export class AppConfigModule {}
