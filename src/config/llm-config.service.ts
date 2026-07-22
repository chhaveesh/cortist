import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigAudit, Env, PROVIDER_KEY_VAR, auditConfig } from './env.schema';

/**
 * Answers one question: can anything that needs the model actually run?
 *
 * Since Phase 4a the router classifies *every* actionable message, so an absent
 * or placeholder API key is no longer a calendar-shaped problem — it stops the
 * system routing at all. Before this service existed that failure had no
 * graceful path: the classifier constructed happily with a null key and threw
 * `401 invalid x-api-key` at request time, which BullMQ retried three times and
 * dropped into the failed set. The user was told nothing, and because the
 * processed marker is written after the agent runs, `processed_messages`
 * recorded nothing either — the message vanished.
 *
 * The calendar agent has answered this honestly since Phase 2 (§32). This is
 * the same judgement applied one layer up, where it now matters more.
 *
 * Provider-aware: only the *active* provider's key is required, so a Gemini
 * deployment is not reported broken for lacking an Anthropic key it will never
 * call.
 */
@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);
  private readonly audit: ConfigAudit;
  readonly provider: Env['LLM_PROVIDER'];
  readonly keyVar: string;

  constructor(config: ConfigService<Env, true>) {
    this.provider = config.get('LLM_PROVIDER', { infer: true }) ?? 'gemini';
    this.keyVar = PROVIDER_KEY_VAR[this.provider];

    this.audit = auditConfig(
      {
        ANTHROPIC_API_KEY: config.get('ANTHROPIC_API_KEY', { infer: true }),
        GEMINI_API_KEY: config.get('GEMINI_API_KEY', { infer: true }),
      },
      [this.keyVar],
    );

    if (!this.isConfigured) {
      const reason =
        this.audit.missing.length > 0
          ? 'missing'
          : 'still set to the .env.example placeholder';
      this.logger.warn(
        `Message routing is DEGRADED — ${this.keyVar} is ${reason} ` +
          `(LLM_PROVIDER=${this.provider}). Telegram ingestion and queueing ` +
          'are unaffected, and small talk is still filtered out without a ' +
          'model call, but any message needing classification will be ' +
          'answered with a "not configured" message.',
      );
    } else {
      this.logger.log(
        `LLM provider: ${this.provider} (${this.keyVar} configured)`,
      );
    }
  }

  get isConfigured(): boolean {
    return (
      this.audit.missing.length === 0 && this.audit.placeholder.length === 0
    );
  }

  /** Absent variables, for `/health` and diagnostics. */
  get missingVars(): string[] {
    return [...this.audit.missing];
  }

  /** Variables still holding a placeholder value. */
  get placeholderVars(): string[] {
    return [...this.audit.placeholder];
  }
}
