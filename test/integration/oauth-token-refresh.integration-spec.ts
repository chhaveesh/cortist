import {
  CalendarHarness,
  connectCalendar,
  createCalendarHarness,
  destroyCalendarHarness,
  resetCalendarState,
  seedTenant,
} from '../calendar-harness';
import {
  GOOGLE_CALENDAR_PROVIDER,
  MissingOAuthConnectionError,
  OAuthReauthorizationRequiredError,
} from '../../src/oauth/oauth-token.service';

describe('OAuth token refresh (integration)', () => {
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

  const storedRow = () =>
    harness.prisma.oAuthToken.findUniqueOrThrow({
      where: {
        userId_provider: {
          userId: tenantId,
          provider: GOOGLE_CALENDAR_PROVIDER,
        },
      },
    });

  it('returns the stored token unchanged while it is still valid', async () => {
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const token = await harness.tokens.getAccessToken(tenantId);

    expect(token).toBe('stored-access-token');
    expect(harness.googleOAuth.refreshedTokens).toEqual([]);
  });

  it('refreshes an expired token, stores the new one, and returns it', async () => {
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000), // already expired
      refreshToken: 'the-refresh-token',
    });

    harness.googleOAuth.setRefreshResult({
      accessToken: 'brand-new-access-token',
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const token = await harness.tokens.getAccessToken(tenantId);

    // The caller gets a working token and never learns a refresh happened.
    expect(token).toBe('brand-new-access-token');
    expect(harness.googleOAuth.refreshedTokens).toEqual(['the-refresh-token']);

    const row = await storedRow();
    expect(harness.encryption.decrypt(row.accessTokenEncrypted)).toBe(
      'brand-new-access-token',
    );
  });

  it('refreshes proactively, just before the token actually expires', async () => {
    // Within the 60s skew window. Waiting for true expiry would let a token die
    // mid-request.
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() + 20_000),
    });

    await harness.tokens.getAccessToken(tenantId);

    expect(harness.googleOAuth.refreshedTokens).toHaveLength(1);
  });

  it('preserves the stored refresh token when Google omits one', async () => {
    // Google usually returns no refresh token on refresh. Treating that as
    // "removed" would break the connection on the following refresh.
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: 'long-lived-refresh-token',
    });

    harness.googleOAuth.setRefreshResult({
      accessToken: 'new-access',
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await harness.tokens.getAccessToken(tenantId);

    const row = await storedRow();
    expect(row.refreshTokenEncrypted).not.toBeNull();
    expect(
      harness.encryption.decrypt(row.refreshTokenEncrypted as string),
    ).toBe('long-lived-refresh-token');
  });

  it('stores a rotated refresh token when Google does return one', async () => {
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: 'old-refresh',
    });

    harness.googleOAuth.setRefreshResult({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await harness.tokens.getAccessToken(tenantId);

    const row = await storedRow();
    expect(
      harness.encryption.decrypt(row.refreshTokenEncrypted as string),
    ).toBe('rotated-refresh');
  });

  it('raises a re-authorization error when the refresh token is rejected', async () => {
    // The user revoked access in their Google account. Retrying cannot help.
    await connectCalendar(harness, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    harness.googleOAuth.failRefresh();

    await expect(harness.tokens.getAccessToken(tenantId)).rejects.toThrow(
      OAuthReauthorizationRequiredError,
    );
  });

  it('raises a missing-connection error when the tenant never connected', async () => {
    await expect(harness.tokens.getAccessToken(tenantId)).rejects.toThrow(
      MissingOAuthConnectionError,
    );
  });

  it('reports connection status accurately', async () => {
    expect(await harness.tokens.hasConnection(tenantId)).toBe(false);
    await connectCalendar(harness, tenantId);
    expect(await harness.tokens.hasConnection(tenantId)).toBe(true);

    await harness.tokens.disconnect(tenantId);
    expect(await harness.tokens.hasConnection(tenantId)).toBe(false);
  });
});
