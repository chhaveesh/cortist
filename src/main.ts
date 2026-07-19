import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Env } from './config/env.schema';
import { registerBigIntJson } from './common/bigint-json';

/** Entrypoint: Telegram webhook gateway (HTTP). */
async function bootstrap(): Promise<void> {
  registerBigIntJson();

  const app = await NestFactory.create(AppModule, {
    // Telegram updates are small; a tight body limit blunts trivial abuse.
    bodyParser: true,
  });

  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  await app.listen(port, '0.0.0.0');
  Logger.log(`Cortist gateway listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
