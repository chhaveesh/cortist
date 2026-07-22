import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalendarAgentModule } from '../agents/calendar/calendar-agent.module';
import { RagAgentModule } from '../agents/rag/rag-agent.module';
import { Env } from '../config/env.schema';
import { GeminiClient } from '../llm/gemini.client';
import { LlmModule } from '../llm/llm.module';
import { TelegramOutboundModule } from '../telegram/outbound/telegram-outbound.module';
import { PendingClarificationService } from './clarification/pending-clarification.service';
import { GeminiRouteClassifier } from './intent/gemini-route-classifier.service';
import {
  AnthropicRouteClassifier,
  RouteClassifier,
} from './intent/route-classifier.service';
import { RouterService } from './router.service';

/**
 * The single classification and dispatch point.
 *
 * Imports both agents, which is the one place in the system that knows about
 * more than one — that is the router's job. The agents themselves remain
 * unaware of each other.
 */
@Module({
  imports: [
    CalendarAgentModule,
    RagAgentModule,
    TelegramOutboundModule,
    LlmModule,
  ],
  providers: [
    RouterService,
    PendingClarificationService,
    /**
     * The provider is chosen at boot, not per call: switching mid-process would
     * mean two models classifying the same conversation, and the ambiguity
     * behaviour the clarification flow depends on is model-specific.
     *
     * Tests override this token wholesale with a scripted classifier, so
     * neither branch runs in CI — which is exactly why `eval:router` exists.
     */
    {
      provide: RouteClassifier,
      inject: [ConfigService, GeminiClient],
      useFactory: (config: ConfigService<Env, true>, gemini: GeminiClient) =>
        config.get('LLM_PROVIDER', { infer: true }) === 'gemini'
          ? new GeminiRouteClassifier(gemini)
          : new AnthropicRouteClassifier(config),
    },
  ],
  exports: [RouterService],
})
export class RouterModule {}
