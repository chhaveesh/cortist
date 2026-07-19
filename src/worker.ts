import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { registerBigIntJson } from './common/bigint-json';
import { WorkerAppModule } from './worker.module.root';

/**
 * Entrypoint: queue worker.
 *
 * `createApplicationContext` starts the DI container without an HTTP listener —
 * this process exposes no ports and does nothing but consume jobs.
 */
async function bootstrap(): Promise<void> {
  registerBigIntJson();

  const app = await NestFactory.createApplicationContext(WorkerAppModule);

  // Registers SIGTERM/SIGINT listeners that drive onApplicationShutdown on
  // every provider — including TelegramMessageWorker, which drains in-flight
  // jobs. SIGTERM is what ECS Fargate sends on deploy and scale-down; SIGINT is
  // Ctrl+C locally.
  app.enableShutdownHooks();

  Logger.log('Cortist worker started', 'Bootstrap');
}

void bootstrap();
