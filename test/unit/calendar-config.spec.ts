import { ConfigService } from '@nestjs/config';
import { CalendarConfigService } from '../../src/config/calendar-config.service';
import {
  CALENDAR_REQUIRED_VARS,
  isCalendarConfigured,
  missingCalendarConfig,
  validateEnv,
} from '../../src/config/env.schema';

const FULL = {
  TOKEN_ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  OAUTH_STATE_SECRET: 'a-sufficiently-long-secret',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_WEBHOOK_SECRET: 'secret',
};

function service(overrides: Record<string, string | undefined>) {
  const values = { ...FULL, ...overrides };
  return new CalendarConfigService({
    get: (key: string) => values[key as keyof typeof values],
  } as unknown as ConfigService<never, true>);
}

describe('calendar configuration', () => {
  describe('env schema', () => {
    /**
     * The whole point of the change: a missing calendar credential must not
     * abort bootstrap. Requiring these once crash-looped the gateway, which
     * took the Telegram webhook down and lost messages over a credential the
     * ingestion path never touches.
     */
    it('boots with every calendar variable absent', () => {
      expect(() => validateEnv(BASE_ENV)).not.toThrow();
    });

    it('still validates the format of a value that IS supplied', () => {
      // An 8-character encryption key is a mistake worth failing on; an absent
      // one is a deliberate choice.
      expect(() =>
        validateEnv({ ...BASE_ENV, TOKEN_ENCRYPTION_KEY: 'abcd1234' }),
      ).toThrow(/TOKEN_ENCRYPTION_KEY/);

      expect(() =>
        validateEnv({ ...BASE_ENV, GOOGLE_REDIRECT_URI: 'not-a-url' }),
      ).toThrow(/GOOGLE_REDIRECT_URI/);
    });

    it('accepts a fully configured environment', () => {
      expect(() => validateEnv({ ...BASE_ENV, ...FULL })).not.toThrow();
    });
  });

  describe('missingCalendarConfig', () => {
    it('reports nothing missing when all are present', () => {
      expect(missingCalendarConfig(FULL)).toEqual([]);
      expect(isCalendarConfigured(FULL)).toBe(true);
    });

    it.each(CALENDAR_REQUIRED_VARS)('detects a missing %s', (key) => {
      const partial = { ...FULL, [key]: undefined };
      expect(missingCalendarConfig(partial)).toEqual([key]);
      expect(isCalendarConfigured(partial)).toBe(false);
    });

    it('treats an empty string as missing', () => {
      // A blank line in .env is a common way to "unset" something.
      expect(missingCalendarConfig({ ...FULL, GOOGLE_CLIENT_ID: '' })).toEqual([
        'GOOGLE_CLIENT_ID',
      ]);
    });

    it('lists every absent variable, not just the first', () => {
      const missing = missingCalendarConfig({
        ...FULL,
        GOOGLE_CLIENT_ID: undefined,
        ANTHROPIC_API_KEY: undefined,
      });
      expect(missing.sort()).toEqual(['ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID']);
    });
  });

  describe('CalendarConfigService', () => {
    it('reports configured when everything is present', () => {
      const config = service({});
      expect(config.isConfigured).toBe(true);
      expect(config.missingVars).toEqual([]);
    });

    it('reports unconfigured and names what is missing', () => {
      const config = service({ ANTHROPIC_API_KEY: undefined });
      expect(config.isConfigured).toBe(false);
      expect(config.missingVars).toEqual(['ANTHROPIC_API_KEY']);
    });

    it('does not leak its internal array to callers', () => {
      const config = service({ ANTHROPIC_API_KEY: undefined });
      config.missingVars.push('TAMPERED');
      expect(config.missingVars).toEqual(['ANTHROPIC_API_KEY']);
    });
  });
});
