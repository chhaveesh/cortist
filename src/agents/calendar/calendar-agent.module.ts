import { Module } from '@nestjs/common';
import { OAuthModule } from '../../oauth/oauth.module';
import { TelegramOutboundModule } from '../../telegram/outbound/telegram-outbound.module';
import { CalendarAgentService } from './calendar-agent.service';
import { ConflictDetectorService } from './conflict/conflict-detector.service';
import { CalendarClient } from './google/calendar.port';
import { GoogleCalendarClient } from './google/google-calendar.client';
import {
  AnthropicCalendarIntentClassifier,
  CalendarIntentClassifier,
} from './intent/calendar-intent.service';
import { PendingActionService } from './pending-action/pending-action.service';

/**
 * Self-contained calendar agent.
 *
 * The two outward-facing dependencies — the Calendar API and the LLM — are
 * bound to abstract tokens here. Integration tests override exactly these two
 * providers and nothing else, which is what keeps real Google and Anthropic
 * calls structurally out of CI.
 */
@Module({
  imports: [OAuthModule, TelegramOutboundModule],
  providers: [
    CalendarAgentService,
    ConflictDetectorService,
    PendingActionService,
    { provide: CalendarClient, useClass: GoogleCalendarClient },
    {
      provide: CalendarIntentClassifier,
      useClass: AnthropicCalendarIntentClassifier,
    },
  ],
  exports: [CalendarAgentService],
})
export class CalendarAgentModule {}
