import { Module } from '@nestjs/common';
import { OAuthModule } from '../../oauth/oauth.module';
import { TelegramOutboundModule } from '../../telegram/outbound/telegram-outbound.module';
import { CalendarAgentService } from './calendar-agent.service';
import { ConflictDetectorService } from './conflict/conflict-detector.service';
import { CalendarClient } from './google/calendar.port';
import { GoogleCalendarClient } from './google/google-calendar.client';
import { PendingActionService } from './pending-action/pending-action.service';

/**
 * Self-contained calendar agent.
 *
 * Since Phase 4a the agent no longer classifies — the router does that once, in
 * front of every agent — so the only outward-facing dependency bound here is
 * the Calendar API itself.
 */
@Module({
  imports: [OAuthModule, TelegramOutboundModule],
  providers: [
    CalendarAgentService,
    ConflictDetectorService,
    PendingActionService,
    { provide: CalendarClient, useClass: GoogleCalendarClient },
  ],
  exports: [CalendarAgentService],
})
export class CalendarAgentModule {}
