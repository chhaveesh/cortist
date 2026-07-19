import { Module } from '@nestjs/common';
import { TelegramSenderService } from './telegram-sender.service';

@Module({
  providers: [TelegramSenderService],
  exports: [TelegramSenderService],
})
export class TelegramOutboundModule {}
