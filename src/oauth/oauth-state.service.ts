import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Env } from '../config/env.schema';

export interface OAuthStatePayload {
  /** Internal Cortist user id this consent belongs to. */
  tenantId: string;
  /** Telegram chat to notify once the connection succeeds. */
  chatId: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Random nonce, so two links for the same tenant differ. */
  nonce: string;
}

export class InvalidOAuthStateError extends Error {
  readonly name = 'InvalidOAuthStateError';
}

/**
 * Signed, short-lived OAuth `state` parameter.
 *
 * Telegram users arrive at Google through a link, not a browser session we
 * control, so the callback has no cookie to tell us who came back. The state
 * parameter carries that identity — which means it must be unforgeable, or
 * anyone could bind their own Google account to another tenant's Cortist user.
 *
 * Format: `<base64url(json)>.<base64url(hmac-sha256)>`.
 */
@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);
  /** Undefined when OAUTH_STATE_SECRET is unset — see `requireSecret`. */
  private readonly secret: string | undefined;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('OAUTH_STATE_SECRET', { infer: true });
    this.ttlSeconds = config.get('OAUTH_STATE_TTL_SECONDS', { infer: true });
  }

  /**
   * Signing with an absent secret would produce states anyone could forge, so
   * this throws rather than degrading. Construction still succeeds, so a
   * missing calendar credential cannot crash the gateway at DI time.
   */
  private requireSecret(): string {
    if (!this.secret) {
      throw new Error(
        'OAUTH_STATE_SECRET is not set — cannot sign or verify OAuth state',
      );
    }
    return this.secret;
  }

  issue(tenantId: string, chatId: string, now = new Date()): string {
    const payload: OAuthStatePayload = {
      tenantId,
      chatId,
      iat: Math.floor(now.getTime() / 1000),
      nonce: randomBytes(9).toString('base64url'),
    };

    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );

    return `${body}.${this.sign(body)}`;
  }

  /**
   * @throws InvalidOAuthStateError if the signature does not verify, the
   *         payload is malformed, or the state has expired.
   */
  verify(state: string, now = new Date()): OAuthStatePayload {
    const parts = state.split('.');
    if (parts.length !== 2) {
      throw new InvalidOAuthStateError('Malformed state parameter');
    }

    const [body, signature] = parts;

    // Verify before parsing: never deserialize data we have not authenticated.
    if (!this.signatureMatches(body, signature)) {
      this.logger.warn(
        'Rejected OAuth callback with an invalid state signature',
      );
      throw new InvalidOAuthStateError('State signature does not verify');
    }

    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as OAuthStatePayload;
    } catch {
      throw new InvalidOAuthStateError('State payload is not valid JSON');
    }

    if (
      typeof payload?.tenantId !== 'string' ||
      typeof payload?.chatId !== 'string' ||
      typeof payload?.iat !== 'number'
    ) {
      throw new InvalidOAuthStateError('State payload is missing fields');
    }

    const ageSeconds = Math.floor(now.getTime() / 1000) - payload.iat;
    if (ageSeconds > this.ttlSeconds) {
      throw new InvalidOAuthStateError('State has expired');
    }
    // A future-dated state means a forged or clock-skewed payload.
    if (ageSeconds < -60) {
      throw new InvalidOAuthStateError('State is not yet valid');
    }

    return payload;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.requireSecret())
      .update(body)
      .digest('base64url');
  }

  private signatureMatches(body: string, provided: string): boolean {
    const expected = Buffer.from(this.sign(body), 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
