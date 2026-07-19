import http from 'node:http';
import https from 'node:https';
import {
  ExternalNetworkAccessError,
  installNetworkGuard,
  isAllowedHost,
} from '../network-guard';

/**
 * A guard nobody tests is worse than no guard — it produces false confidence.
 * These cases prove it actually blocks the hosts Phase 2 talks to, and actually
 * lets the test infrastructure through.
 */
describe('network guard', () => {
  describe('isAllowedHost', () => {
    it.each([
      'localhost',
      '127.0.0.1',
      '::1',
      'localhost:55432',
      '127.0.0.1:56379',
    ])('allows local infrastructure: %s', (host) => {
      expect(isAllowedHost(host)).toBe(true);
    });

    it.each([
      'api.telegram.org',
      'accounts.google.com',
      'www.googleapis.com',
      'api.anthropic.com',
      'oauth2.googleapis.com',
    ])('blocks the external host: %s', (host) => {
      expect(isAllowedHost(host)).toBe(false);
    });
  });

  describe('once installed', () => {
    const originalFetch = globalThis.fetch;
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;

    beforeAll(() => {
      installNetworkGuard();
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
      http.request = originalHttpRequest;
      https.request = originalHttpsRequest;
    });

    it('blocks fetch to an external host', async () => {
      // This is the exact call the Telegram sender makes.
      await expect(
        fetch('https://api.telegram.org/bot123/sendMessage', {
          method: 'POST',
        }),
      ).rejects.toThrow(ExternalNetworkAccessError);
    });

    it('blocks https.request to an external host', () => {
      // googleapis (gaxios) uses the https module, not fetch.
      expect(() =>
        https.request('https://www.googleapis.com/calendar/v3'),
      ).toThrow(ExternalNetworkAccessError);
    });

    it('blocks an options-object request', () => {
      expect(() =>
        https.request({ hostname: 'oauth2.googleapis.com', path: '/token' }),
      ).toThrow(ExternalNetworkAccessError);
    });

    it('names the offending host and suggests the fix', () => {
      try {
        https.request({ hostname: 'api.anthropic.com' });
        throw new Error('expected the guard to throw');
      } catch (error) {
        expect((error as Error).message).toContain('api.anthropic.com');
        expect((error as Error).message).toContain('stub it');
      }
    });

    it('still allows localhost, so Postgres and Redis keep working', () => {
      // Asserting only that the guard permits the call — not that anything is
      // listening. The error handler is attached before destroy() because an
      // unhandled socket 'error' would crash the worker process rather than
      // failing this test.
      expect(() => {
        const request = http.request({ hostname: '127.0.0.1', port: 1 });
        request.on('error', () => undefined);
        request.destroy();
      }).not.toThrow();
    });
  });
});
