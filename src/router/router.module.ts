import { Module } from '@nestjs/common';
import { CalendarAgentModule } from '../agents/calendar/calendar-agent.module';
import { RagAgentModule } from '../agents/rag/rag-agent.module';
import { TelegramOutboundModule } from '../telegram/outbound/telegram-outbound.module';
import { PendingClarificationService } from './clarification/pending-clarification.service';
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
  imports: [CalendarAgentModule, RagAgentModule, TelegramOutboundModule],
  providers: [
    RouterService,
    PendingClarificationService,
    { provide: RouteClassifier, useClass: AnthropicRouteClassifier },
  ],
  exports: [RouterService],
})
export class RouterModule {}
