import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { Env } from '../config/env.schema';

/**
 * `googleapis` bundles its own nested copy of google-auth-library, and the two
 * OAuth2Client classes are structurally incompatible (separate declarations of
 * a private field). Deriving the type from the factory keeps us on whichever
 * copy `googleapis` actually uses, instead of importing the wrong one.
 */
type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/**
 * Least-privilege scope. `calendar.events` grants read+write on events — enough
 * to list (for conflict detection), create, update, and delete — without the
 * broad `calendar` scope that also exposes calendar management and sharing.
 *
 * The calendar's timezone comes back on the events.list response, so we do not
 * need `calendar.settings.readonly` to resolve "tomorrow at 3pm".
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
];

export interface GoogleTokens {
  accessToken: string;
  /** Absent when Google declines to re-issue one on a repeat consent. */
  refreshToken?: string;
  expiresAt: Date;
}

/**
 * Thin, mockable seam over Google's OAuth endpoints.
 *
 * Everything that talks to accounts.google.com lives here, so tests can swap
 * the whole class out and never touch the network.
 */
@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  createOAuth2Client(): GoogleOAuth2Client {
    return new google.auth.OAuth2(
      this.config.get('GOOGLE_CLIENT_ID', { infer: true }),
      this.config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      this.config.get('GOOGLE_REDIRECT_URI', { infer: true }),
    );
  }

  /**
   * `access_type: 'offline'` is what makes Google issue a refresh token;
   * `prompt: 'consent'` forces it to re-issue one even on a repeat
   * authorization, which is the difference between an integration that keeps
   * working and one that dies the first time an access token expires.
   */
  buildConsentUrl(state: string): string {
    return this.createOAuth2Client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_CALENDAR_SCOPES,
      include_granted_scopes: true,
      state,
    });
  }

  async exchangeCode(code: string): Promise<GoogleTokens> {
    const client = this.createOAuth2Client();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      throw new Error('Google returned no access token for the code exchange');
    }
    if (!tokens.refresh_token) {
      // Recoverable — we may already hold one — but worth surfacing, since it
      // usually means `prompt: 'consent'` was dropped from the consent URL.
      this.logger.warn(
        'Google returned no refresh token; a previously stored one must be reused',
      );
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: this.resolveExpiry(tokens.expiry_date),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    const client = this.createOAuth2Client();
    client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error('Google returned no access token for the refresh');
    }

    return {
      accessToken: credentials.access_token,
      // Google usually omits this on refresh — the caller keeps the existing one.
      refreshToken: credentials.refresh_token ?? undefined,
      expiresAt: this.resolveExpiry(credentials.expiry_date),
    };
  }

  private resolveExpiry(expiryDate: number | null | undefined): Date {
    // Google normally sends expiry_date. Falling back to a conservative hour
    // keeps a missing value from being read as "already expired" (epoch 0),
    // which would send us into a refresh loop.
    return expiryDate ? new Date(expiryDate) : new Date(Date.now() + 3_600_000);
  }
}
