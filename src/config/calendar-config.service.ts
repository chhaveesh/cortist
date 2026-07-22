import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConfigAudit,
  Env,
  auditConfig,
  calendarRequiredVars,
  isCalendarConfigured,
} from './env.schema';

/**
 * Answers one question: can the calendar agent actually run?
 *
 * Exists because the Phase 2 credentials are optional (see env.schema.ts). The
 * agent asks this before touching Google or Anthropic, and `/health` reports it,
 * so an unconfigured deployment is visible rather than silently inert.
 *
 * "Configured" means present *and* not a placeholder. Presence alone was not
 * enough: `cp .env.example .env` — the setup the README recommends — leaves
 * every credential non-empty, so the service reported itself configured and the
 * degraded-mode reply the user was supposed to get never fired. The failure
 * surfaced instead as a 401 from Anthropic three retries deep, with the user
 * told nothing.
 */
@Injectable()
export class CalendarConfigService {
  private readonly logger = new Logger(CalendarConfigService.name);
  private readonly audit: ConfigAudit;

  constructor(config: ConfigService<Env, true>) {
    this.audit = auditConfig(
      {
        TOKEN_ENCRYPTION_KEY: config.get('TOKEN_ENCRYPTION_KEY', {
          infer: true,
        }),
        GOOGLE_CLIENT_ID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
        GOOGLE_CLIENT_SECRET: config.get('GOOGLE_CLIENT_SECRET', {
          infer: true,
        }),
        GOOGLE_REDIRECT_URI: config.get('GOOGLE_REDIRECT_URI', { infer: true }),
        OAUTH_STATE_SECRET: config.get('OAUTH_STATE_SECRET', { infer: true }),
        ANTHROPIC_API_KEY: config.get('ANTHROPIC_API_KEY', { infer: true }),
        GEMINI_API_KEY: config.get('GEMINI_API_KEY', { infer: true }),
      },
      // Only the active provider's key counts: reporting ANTHROPIC_API_KEY
      // missing on a Gemini deployment is exactly the misleading diagnostic
      // the placeholder work set out to remove.
      calendarRequiredVars(
        config.get('LLM_PROVIDER', { infer: true }) ?? 'gemini',
      ),
    );

    if (!this.isConfigured) {
      // Warn once at boot rather than per message. Silence here would make an
      // unconfigured deployment look like a broken one.
      //
      // Placeholders are named separately from absences on purpose: "missing"
      // sends you looking for a variable you can plainly see in your .env.
      const parts = [
        this.audit.missing.length > 0
          ? `missing: ${this.audit.missing.join(', ')}`
          : null,
        this.audit.placeholder.length > 0
          ? `still set to the .env.example placeholder: ${this.audit.placeholder.join(', ')}`
          : null,
      ].filter((part): part is string => part !== null);

      this.logger.warn(
        `Calendar agent is DISABLED — ${parts.join('; ')}. ` +
          'Telegram ingestion and queueing are unaffected; calendar requests ' +
          'will be answered with a "not configured" message.',
      );
    }
  }

  get isConfigured(): boolean {
    return (
      this.audit.missing.length === 0 && this.audit.placeholder.length === 0
    );
  }

  /** Names of the absent variables, for `/health` and diagnostics. */
  get missingVars(): string[] {
    return [...this.audit.missing];
  }

  /** Names of the variables still holding a placeholder value. */
  get placeholderVars(): string[] {
    return [...this.audit.placeholder];
  }
}

export { isCalendarConfigured };
