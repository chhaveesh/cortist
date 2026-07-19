import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenEncryptionService } from '../crypto/token-encryption.service';
import { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleOAuthClient, GoogleTokens } from './google-oauth.client';

export const GOOGLE_CALENDAR_PROVIDER = 'google_calendar';

/** Refresh this far before actual expiry, so a token cannot die mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export class MissingOAuthConnectionError extends Error {
  readonly name = 'MissingOAuthConnectionError';
}

/**
 * Raised when the stored refresh token no longer works — typically because the
 * user revoked access in their Google account. The only remedy is re-consent,
 * so callers should prompt the user rather than retry.
 */
export class OAuthReauthorizationRequiredError extends Error {
  readonly name = 'OAuthReauthorizationRequiredError';
}

/**
 * Owns OAuth token persistence and the refresh lifecycle.
 *
 * Callers ask for a usable access token and get one; whether that involved a
 * refresh is an implementation detail they never see.
 */
@Injectable()
export class OAuthTokenService {
  private readonly logger = new Logger(OAuthTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: TokenEncryptionService,
    private readonly googleOAuth: GoogleOAuthClient,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async hasConnection(
    tenantId: string,
    provider = GOOGLE_CALENDAR_PROVIDER,
  ): Promise<boolean> {
    const count = await this.prisma.oAuthToken.count({
      where: { userId: tenantId, provider },
    });
    return count > 0;
  }

  /**
   * Persist a freshly-exchanged token set.
   *
   * A missing refresh token preserves the stored one rather than nulling it:
   * Google only issues a refresh token on first consent, so treating "absent"
   * as "removed" would silently break the connection on re-consent.
   */
  async store(
    tenantId: string,
    tokens: GoogleTokens,
    provider = GOOGLE_CALENDAR_PROVIDER,
  ): Promise<void> {
    const accessTokenEncrypted = this.encryption.encrypt(tokens.accessToken);
    const refreshTokenEncrypted = tokens.refreshToken
      ? this.encryption.encrypt(tokens.refreshToken)
      : undefined;

    await this.prisma.oAuthToken.upsert({
      where: { userId_provider: { userId: tenantId, provider } },
      create: {
        userId: tenantId,
        provider,
        accessTokenEncrypted,
        refreshTokenEncrypted: refreshTokenEncrypted ?? null,
        expiresAt: tokens.expiresAt,
      },
      update: {
        accessTokenEncrypted,
        expiresAt: tokens.expiresAt,
        ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
      },
    });

    this.logger.log(`Stored ${provider} tokens for tenant ${tenantId}`);
  }

  /**
   * Return an access token that is valid right now, refreshing transparently
   * if the stored one has expired or is about to.
   *
   * @throws MissingOAuthConnectionError if the tenant has never connected.
   * @throws OAuthReauthorizationRequiredError if the refresh token is rejected.
   */
  async getAccessToken(
    tenantId: string,
    provider = GOOGLE_CALENDAR_PROVIDER,
    now = new Date(),
  ): Promise<string> {
    const row = await this.prisma.oAuthToken.findUnique({
      where: { userId_provider: { userId: tenantId, provider } },
    });

    if (!row) {
      throw new MissingOAuthConnectionError(
        `Tenant ${tenantId} has no ${provider} connection`,
      );
    }

    if (row.expiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime()) {
      return this.encryption.decrypt(row.accessTokenEncrypted);
    }

    if (!row.refreshTokenEncrypted) {
      throw new OAuthReauthorizationRequiredError(
        `Access token for tenant ${tenantId} expired and no refresh token is stored`,
      );
    }

    this.logger.log(
      `Refreshing expired ${provider} token for tenant ${tenantId}`,
    );

    const refreshToken = this.encryption.decrypt(row.refreshTokenEncrypted);

    let refreshed: GoogleTokens;
    try {
      refreshed = await this.googleOAuth.refreshAccessToken(refreshToken);
    } catch (error) {
      // A rejected refresh token is terminal — the user revoked access, or it
      // was invalidated. Retrying cannot help; only re-consent can.
      this.logger.warn(
        `Refresh failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new OAuthReauthorizationRequiredError(
        `Refresh token for tenant ${tenantId} was rejected`,
      );
    }

    await this.store(tenantId, refreshed, provider);

    return refreshed.accessToken;
  }

  async disconnect(
    tenantId: string,
    provider = GOOGLE_CALENDAR_PROVIDER,
  ): Promise<void> {
    await this.prisma.oAuthToken.deleteMany({
      where: { userId: tenantId, provider },
    });
  }

  /** Public URL a user follows to connect their calendar. */
  buildConnectUrl(state: string): string {
    const base = this.config.get('PUBLIC_BASE_URL', { infer: true });
    return `${base.replace(/\/$/, '')}/auth/google?state=${encodeURIComponent(state)}`;
  }
}
