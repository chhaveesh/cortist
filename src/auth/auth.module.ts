import { Module } from '@nestjs/common';
import { OAuthModule } from '../oauth/oauth.module';
import { TelegramOutboundModule } from '../telegram/outbound/telegram-outbound.module';
import { GoogleAuthController } from './google-auth.controller';

/**
 * The browser-facing OAuth endpoints. Gateway-only — the worker has no HTTP
 * listener and never serves these.
 */
@Module({
  imports: [OAuthModule, TelegramOutboundModule],
  controllers: [GoogleAuthController],
})
export class AuthModule {}
