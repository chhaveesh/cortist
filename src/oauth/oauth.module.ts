import { Module } from '@nestjs/common';
import { GoogleOAuthClient } from './google-oauth.client';
import { OAuthStateService } from './oauth-state.service';
import { OAuthTokenService } from './oauth-token.service';

/**
 * Shared by both composition roots: the gateway serves the consent/callback
 * endpoints, and the worker needs tokens to call the Calendar API.
 */
@Module({
  providers: [GoogleOAuthClient, OAuthStateService, OAuthTokenService],
  exports: [GoogleOAuthClient, OAuthStateService, OAuthTokenService],
})
export class OAuthModule {}
