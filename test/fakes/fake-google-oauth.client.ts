import { GoogleTokens } from '../../src/oauth/google-oauth.client';

/**
 * Stands in for the Google OAuth endpoints.
 *
 * Shaped to match GoogleOAuthClient's public surface. `buildConsentUrl` returns
 * a fake accounts.google.com URL so the redirect can be asserted on without any
 * network call.
 */
export class FakeGoogleOAuthClient {
  readonly exchangedCodes: string[] = [];
  readonly refreshedTokens: string[] = [];

  private nextExchange: GoogleTokens | null = null;
  private nextRefresh: GoogleTokens | null = null;
  private refreshShouldFail = false;

  /** Tokens the next code exchange returns. */
  setExchangeResult(tokens: GoogleTokens): void {
    this.nextExchange = tokens;
  }

  /** Tokens the next refresh returns. */
  setRefreshResult(tokens: GoogleTokens): void {
    this.nextRefresh = tokens;
    this.refreshShouldFail = false;
  }

  /** Simulate a revoked or invalidated refresh token. */
  failRefresh(): void {
    this.refreshShouldFail = true;
  }

  reset(): void {
    this.exchangedCodes.length = 0;
    this.refreshedTokens.length = 0;
    this.nextExchange = null;
    this.nextRefresh = null;
    this.refreshShouldFail = false;
  }

  buildConsentUrl(state: string): string {
    return `https://accounts.google.com/o/oauth2/v2/auth?fake=1&state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string): Promise<GoogleTokens> {
    this.exchangedCodes.push(code);

    return (
      this.nextExchange ?? {
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: new Date(Date.now() + 3_600_000),
      }
    );
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    this.refreshedTokens.push(refreshToken);

    if (this.refreshShouldFail) {
      throw new Error('invalid_grant: Token has been expired or revoked.');
    }

    return (
      this.nextRefresh ?? {
        accessToken: 'refreshed-access-token',
        // Google typically omits a refresh token on refresh — modelling that
        // is what exercises the "preserve the stored one" branch.
        refreshToken: undefined,
        expiresAt: new Date(Date.now() + 3_600_000),
      }
    );
  }
}
