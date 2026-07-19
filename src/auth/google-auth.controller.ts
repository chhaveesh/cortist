import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { GoogleOAuthClient } from '../oauth/google-oauth.client';
import {
  InvalidOAuthStateError,
  OAuthStateService,
} from '../oauth/oauth-state.service';
import { OAuthTokenService } from '../oauth/oauth-token.service';
import { TelegramSenderService } from '../telegram/outbound/telegram-sender.service';

/**
 * The browser half of the Telegram → Google connection.
 *
 * The user starts in Telegram, follows a link here, consents at Google, and
 * lands back on the callback. Nothing in that round trip carries a session, so
 * identity rides entirely on the signed `state` parameter.
 */
@Controller('auth/google')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);

  constructor(
    private readonly googleOAuth: GoogleOAuthClient,
    private readonly state: OAuthStateService,
    private readonly tokens: OAuthTokenService,
    private readonly telegram: TelegramSenderService,
  ) {}

  /**
   * Redirects to Google's consent screen.
   *
   * The `state` was minted by the agent when it told the user to connect, so
   * this endpoint validates it up front rather than passing an unverified
   * value through to Google.
   */
  @Get()
  async start(
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!state) {
      throw new BadRequestException('Missing state parameter');
    }

    try {
      this.state.verify(state);
    } catch (error) {
      if (error instanceof InvalidOAuthStateError) {
        throw new BadRequestException(
          'This link is invalid or has expired. Ask Cortist for a new one.',
        );
      }
      throw error;
    }

    res.redirect(this.googleOAuth.buildConsentUrl(state));
  }

  /**
   * Google redirects here after consent.
   *
   * Returns HTML rather than JSON because a human is looking at it — the user
   * is in a browser tab and needs to know to go back to Telegram.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      // The user pressed "Cancel" on Google's consent screen.
      this.logger.log(`OAuth consent declined: ${error}`);
      res
        .status(400)
        .send(this.page('Connection cancelled', 'No changes were made.'));
      return;
    }

    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter');
    }

    let payload;
    try {
      payload = this.state.verify(state);
    } catch (stateError) {
      if (stateError instanceof InvalidOAuthStateError) {
        this.logger.warn(`Rejected callback: ${stateError.message}`);
        res
          .status(400)
          .send(
            this.page(
              'Link expired',
              'Send Cortist another calendar message to get a fresh link.',
            ),
          );
        return;
      }
      throw stateError;
    }

    const googleTokens = await this.googleOAuth.exchangeCode(code);
    await this.tokens.store(payload.tenantId, googleTokens);

    this.logger.log(`Connected Google Calendar for tenant ${payload.tenantId}`);

    // Close the loop in the channel the user actually started in. A failure to
    // notify must not fail the connection — the tokens are already stored.
    await this.telegram
      .sendMessage(
        payload.chatId,
        '✅ Your Google Calendar is connected. Try me again — for example, ' +
          '"what\'s on my calendar tomorrow?"',
      )
      .catch((sendError: unknown) => {
        this.logger.warn(
          `Calendar connected but the Telegram confirmation failed: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      });

    res.send(
      this.page(
        'Calendar connected',
        'You can close this tab and return to Telegram.',
      ),
    );
  }

  private page(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cortist — ${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;
min-height:100vh;margin:0;background:#f6f7f9;color:#1a1a1a}
main{text-align:center;padding:2rem;max-width:28rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#555;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  }
}
