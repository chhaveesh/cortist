import request from 'supertest';
import {
  CalendarHarness,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  seedTenant,
} from '../calendar-harness';
import { GOOGLE_CALENDAR_PROVIDER } from '../../src/oauth/oauth-token.service';

describe('Google OAuth flow (integration)', () => {
  let harness: CalendarHarness;
  let tenantId: string;

  beforeAll(async () => {
    harness = await createCalendarHarness();
  });

  afterAll(async () => {
    await destroyCalendarHarness(harness);
  });

  beforeEach(async () => {
    await resetCalendarState(harness);
    tenantId = await seedTenant(harness);
  });

  const http = () => request(harness.app.getHttpServer());

  describe('GET /auth/google', () => {
    it('redirects to Google with a valid state', async () => {
      const state = harness.oauthState.issue(tenantId, '900100100');

      const response = await http().get('/auth/google').query({ state });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('accounts.google.com');
      expect(response.headers.location).toContain(encodeURIComponent(state));
    });

    it('rejects a missing state', async () => {
      await http().get('/auth/google').expect(400);
    });

    it('rejects a forged state', async () => {
      await http()
        .get('/auth/google')
        .query({ state: 'bogus.signature' })
        .expect(400);
    });

    it('rejects an expired state', async () => {
      // Issued well beyond OAUTH_STATE_TTL_SECONDS (900) ago.
      const stale = harness.oauthState.issue(
        tenantId,
        '900100100',
        new Date(Date.now() - 3_600_000),
      );

      await http().get('/auth/google').query({ state: stale }).expect(400);
    });
  });

  describe('GET /auth/google/callback', () => {
    it('exchanges the code and stores encrypted tokens against the right tenant', async () => {
      const state = harness.oauthState.issue(tenantId, '900100100');

      harness.googleOAuth.setExchangeResult({
        accessToken: 'granted-access-token',
        refreshToken: 'granted-refresh-token',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      const response = await http()
        .get('/auth/google/callback')
        .query({ code: 'auth-code-123', state });

      expect(response.status).toBe(200);
      expect(harness.googleOAuth.exchangedCodes).toEqual(['auth-code-123']);

      const row = await harness.prisma.oAuthToken.findUniqueOrThrow({
        where: {
          userId_provider: {
            userId: tenantId,
            provider: GOOGLE_CALENDAR_PROVIDER,
          },
        },
      });

      // The tokens must not be readable from the database.
      expect(row.accessTokenEncrypted).not.toContain('granted-access-token');
      expect(row.refreshTokenEncrypted).not.toContain('granted-refresh-token');
      expect(row.accessTokenEncrypted.startsWith('v1:')).toBe(true);

      // ...but must decrypt back to exactly what Google returned.
      expect(harness.encryption.decrypt(row.accessTokenEncrypted)).toBe(
        'granted-access-token',
      );
      expect(
        harness.encryption.decrypt(row.refreshTokenEncrypted as string),
      ).toBe('granted-refresh-token');
      expect(row.expiresAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('correlates the callback to the tenant named in the state, not any other', async () => {
      const otherTenant = await seedTenant(harness, 900_200_200, 900_200_200);
      const state = harness.oauthState.issue(otherTenant, '900200200');

      await http()
        .get('/auth/google/callback')
        .query({ code: 'code', state })
        .expect(200);

      expect(
        await harness.prisma.oAuthToken.count({
          where: { userId: otherTenant },
        }),
      ).toBe(1);
      expect(
        await harness.prisma.oAuthToken.count({ where: { userId: tenantId } }),
      ).toBe(0);
    });

    it('notifies the user in Telegram once connected', async () => {
      const state = harness.oauthState.issue(tenantId, '555000111');

      await http()
        .get('/auth/google/callback')
        .query({ code: 'code', state })
        .expect(200);

      expect(harness.telegram.sent).toHaveLength(1);
      expect(harness.telegram.last?.chatId).toBe('555000111');
      expect(harness.telegram.last?.text).toContain('connected');
    });

    it('still stores the tokens when the Telegram notification fails', async () => {
      // The connection succeeded; a messaging blip must not undo it.
      const state = harness.oauthState.issue(tenantId, '900100100');
      harness.telegram.failNextSend();

      await http()
        .get('/auth/google/callback')
        .query({ code: 'code', state })
        .expect(200);

      expect(
        await harness.prisma.oAuthToken.count({ where: { userId: tenantId } }),
      ).toBe(1);
    });

    it('handles the user declining consent', async () => {
      const state = harness.oauthState.issue(tenantId, '900100100');

      const response = await http()
        .get('/auth/google/callback')
        .query({ error: 'access_denied', state });

      expect(response.status).toBe(400);
      expect(await harness.prisma.oAuthToken.count()).toBe(0);
      expect(harness.googleOAuth.exchangedCodes).toEqual([]);
    });

    it('rejects a forged state without exchanging the code', async () => {
      const response = await http()
        .get('/auth/google/callback')
        .query({ code: 'attacker-code', state: 'forged.state' });

      expect(response.status).toBe(400);
      expect(harness.googleOAuth.exchangedCodes).toEqual([]);
      expect(await harness.prisma.oAuthToken.count()).toBe(0);
    });

    it('rejects a callback with no code', async () => {
      const state = harness.oauthState.issue(tenantId, '900100100');
      await http().get('/auth/google/callback').query({ state }).expect(400);
    });

    it('replaces tokens on re-consent rather than duplicating the row', async () => {
      const state = harness.oauthState.issue(tenantId, '900100100');

      harness.googleOAuth.setExchangeResult({
        accessToken: 'first',
        refreshToken: 'first-refresh',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await http()
        .get('/auth/google/callback')
        .query({ code: 'c1', state })
        .expect(200);

      harness.googleOAuth.setExchangeResult({
        accessToken: 'second',
        refreshToken: 'second-refresh',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await http()
        .get('/auth/google/callback')
        .query({ code: 'c2', state })
        .expect(200);

      const rows = await harness.prisma.oAuthToken.findMany({
        where: { userId: tenantId },
      });
      expect(rows).toHaveLength(1);
      expect(harness.encryption.decrypt(rows[0].accessTokenEncrypted)).toBe(
        'second',
      );
    });
  });
});
