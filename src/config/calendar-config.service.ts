import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env, isCalendarConfigured, missingCalendarConfig } from './env.schema';

/**
 * Answers one question: can the calendar agent actually run?
 *
 * Exists because the Phase 2 credentials are optional (see env.schema.ts). The
 * agent asks this before touching Google or Anthropic, and `/health` reports it,
 * so an unconfigured deployment is visible rather than silently inert.
 */
@Injectable()
export class CalendarConfigService {
  private readonly logger = new Logger(CalendarConfigService.name);
  private readonly missing: string[];

  constructor(config: ConfigService<Env, true>) {
    this.missing = missingCalendarConfig({
      TOKEN_ENCRYPTION_KEY: config.get('TOKEN_ENCRYPTION_KEY', { infer: true }),
      GOOGLE_CLIENT_ID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
      GOOGLE_CLIENT_SECRET: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      GOOGLE_REDIRECT_URI: config.get('GOOGLE_REDIRECT_URI', { infer: true }),
      OAUTH_STATE_SECRET: config.get('OAUTH_STATE_SECRET', { infer: true }),
      ANTHROPIC_API_KEY: config.get('ANTHROPIC_API_KEY', { infer: true }),
    });

    if (this.missing.length > 0) {
      // Warn once at boot rather than per message. Silence here would make an
      // unconfigured deployment look like a broken one.
      this.logger.warn(
        `Calendar agent is DISABLED — missing: ${this.missing.join(', ')}. ` +
          'Telegram ingestion and queueing are unaffected; calendar requests ' +
          'will be answered with a "not configured" message.',
      );
    }
  }

  get isConfigured(): boolean {
    return this.missing.length === 0;
  }

  /** Names of the absent variables, for `/health` and diagnostics. */
  get missingVars(): string[] {
    return [...this.missing];
  }
}

export { isCalendarConfigured };
