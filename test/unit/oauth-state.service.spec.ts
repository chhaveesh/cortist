import { ConfigService } from '@nestjs/config';
import {
  InvalidOAuthStateError,
  OAuthStateService,
} from '../../src/oauth/oauth-state.service';

const TENANT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const CHAT = '424242';
const TTL = 900;

function build(secret = 'test-oauth-state-secret-value'): OAuthStateService {
  return new OAuthStateService({
    get: (key: string) => (key === 'OAUTH_STATE_SECRET' ? secret : TTL),
  } as unknown as ConfigService<never, true>);
}

describe('OAuthStateService', () => {
  let service: OAuthStateService;

  beforeEach(() => {
    service = build();
  });

  it('round-trips tenant and chat through issue/verify', () => {
    const state = service.issue(TENANT, CHAT);
    const payload = service.verify(state);

    expect(payload.tenantId).toBe(TENANT);
    expect(payload.chatId).toBe(CHAT);
  });

  it('issues a different state each time for the same tenant', () => {
    // The nonce is what prevents a state from being a stable, replayable
    // identifier for a tenant.
    expect(service.issue(TENANT, CHAT)).not.toBe(service.issue(TENANT, CHAT));
  });

  it('rejects a payload tampered to point at another tenant', () => {
    // This is the attack the signature exists to stop: swapping the tenant id
    // would otherwise bind an attacker's Google account to someone else's user.
    const state = service.issue(TENANT, CHAT);
    const [body, signature] = state.split('.');

    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    decoded.tenantId = '00000000-0000-0000-0000-000000000000';
    const forgedBody = Buffer.from(JSON.stringify(decoded)).toString(
      'base64url',
    );

    expect(() => service.verify(`${forgedBody}.${signature}`)).toThrow(
      InvalidOAuthStateError,
    );
  });

  it('rejects a tampered signature', () => {
    const [body] = service.issue(TENANT, CHAT).split('.');
    expect(() => service.verify(`${body}.not-the-signature`)).toThrow(
      InvalidOAuthStateError,
    );
  });

  it('rejects a state signed with a different secret', () => {
    const foreign = build('a-completely-different-secret').issue(TENANT, CHAT);
    expect(() => service.verify(foreign)).toThrow(InvalidOAuthStateError);
  });

  it.each([
    ['no separator', 'abcdef'],
    ['too many segments', 'a.b.c'],
    ['empty', ''],
  ])('rejects a malformed state (%s)', (_name, state) => {
    expect(() => service.verify(state)).toThrow(InvalidOAuthStateError);
  });

  it('rejects a state older than the TTL', () => {
    const issuedAt = new Date('2026-07-19T12:00:00.000Z');
    const state = service.issue(TENANT, CHAT, issuedAt);

    const justInside = new Date(issuedAt.getTime() + (TTL - 5) * 1000);
    expect(service.verify(state, justInside).tenantId).toBe(TENANT);

    const justOutside = new Date(issuedAt.getTime() + (TTL + 5) * 1000);
    expect(() => service.verify(state, justOutside)).toThrow(
      InvalidOAuthStateError,
    );
  });

  it('rejects a future-dated state', () => {
    const issuedAt = new Date('2026-07-19T12:00:00.000Z');
    const state = service.issue(TENANT, CHAT, issuedAt);

    // Well before it was issued — a forged or badly skewed payload.
    const before = new Date(issuedAt.getTime() - 600_000);
    expect(() => service.verify(state, before)).toThrow(InvalidOAuthStateError);
  });

  it('tolerates small clock skew', () => {
    const issuedAt = new Date('2026-07-19T12:00:00.000Z');
    const state = service.issue(TENANT, CHAT, issuedAt);

    const slightlyEarly = new Date(issuedAt.getTime() - 30_000);
    expect(service.verify(state, slightlyEarly).tenantId).toBe(TENANT);
  });
});
