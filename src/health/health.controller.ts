import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import Redis from 'ioredis';
import { CalendarConfigService } from '../config/calendar-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

type DependencyStatus = 'connected' | 'disconnected';

export interface HealthResponse {
  status: 'ok' | 'error';
  redis: DependencyStatus;
  postgres: DependencyStatus;
  /**
   * Whether the calendar agent has the credentials it needs. Reported but
   * deliberately NOT part of the 200/503 decision: an unconfigured calendar is
   * a setup state, not an outage, and a 503 would pull a gateway that is
   * happily accepting and queueing messages out of load-balancer rotation.
   */
  calendar: 'configured' | 'not_configured';
  /** Names of the absent calendar variables. Present only when unconfigured. */
  calendarMissing?: string[];
  /** Present only when degraded: which dependencies failed, and why. */
  failures?: Array<{ dependency: string; error: string }>;
}

/**
 * Liveness/readiness probe for the Docker Compose healthcheck today and an
 * ECS/ALB target-group check later.
 *
 * Both dependencies are genuinely exercised on every call — a static 200 would
 * report healthy while the gateway was unable to accept a single message.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly calendarConfig: CalendarConfigService,
  ) {}

  @Get()
  async check(@Res() res: Response): Promise<void> {
    const [postgres, redis] = await Promise.all([
      this.probe('postgres', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const failures = [postgres, redis]
      .filter((result) => result.error !== undefined)
      .map((result) => ({
        dependency: result.dependency,
        error: result.error as string,
      }));

    const healthy = failures.length === 0;

    const calendarConfigured = this.calendarConfig.isConfigured;

    const body: HealthResponse = {
      status: healthy ? 'ok' : 'error',
      redis: redis.error ? 'disconnected' : 'connected',
      postgres: postgres.error ? 'disconnected' : 'connected',
      calendar: calendarConfigured ? 'configured' : 'not_configured',
      ...(calendarConfigured
        ? {}
        : { calendarMissing: this.calendarConfig.missingVars }),
      ...(healthy ? {} : { failures }),
    };

    // 503 is what load balancers act on: it pulls this instance out of
    // rotation rather than sending it traffic it cannot serve.
    res
      .status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }

  private async probe(
    dependency: string,
    check: () => Promise<unknown>,
  ): Promise<{ dependency: string; error?: string }> {
    try {
      await check();
      return { dependency };
    } catch (error) {
      return {
        dependency,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
