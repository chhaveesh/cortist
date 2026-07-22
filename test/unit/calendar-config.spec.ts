import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { CalendarConfigService } from '../../src/config/calendar-config.service';
import {
  auditConfig,
  calendarRequiredVars,
  isCalendarConfigured,
  isPlaceholderValue,
  missingCalendarConfig,
  placeholderCalendarConfig,
  validateEnv,
} from '../../src/config/env.schema';

/** The Anthropic-provider variable set, which these fixtures are written for. */
const CALENDAR_REQUIRED_VARS = [...calendarRequiredVars('anthropic')];

const FULL = {
  // These fixtures predate the provider switch and are written for Anthropic.
  LLM_PROVIDER: 'anthropic',
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

  describe('placeholder detection', () => {
    /**
     * The regression this exists for.
     *
     * `cp .env.example .env` is the setup the README recommends, and it leaves
     * every calendar credential non-empty — so a presence-only check reported
     * `calendar: "configured"` on a stack that could not make a single API
     * call. Reading the shipped file rather than restating its values keeps
     * this honest if someone edits the example.
     */
    it('does not report the shipped .env.example as configured', () => {
      const example = readFileSync(
        join(__dirname, '..', '..', '.env.example'),
        'utf8',
      );

      const values: Record<string, string> = {};
      for (const line of example.split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) values[match[1]] = match[2];
      }

      // Guard against a parse that silently found nothing.
      expect(Object.keys(values).length).toBeGreaterThan(10);

      const audit = auditConfig(values, CALENDAR_REQUIRED_VARS);
      expect(audit.missing).toEqual([]); // every one IS present…
      expect(audit.placeholder.sort()).toEqual([
        // …and every one is a placeholder, which is the whole point.
        'ANTHROPIC_API_KEY',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'OAUTH_STATE_SECRET',
        'TOKEN_ENCRYPTION_KEY',
      ]);
      expect(isCalendarConfigured(values as never)).toBe(false);
    });

    it.each([
      ['your-client-id.apps.googleusercontent.com'],
      ['your-client-secret'],
      ['sk-ant-your-key-here'],
      ['change-me-to-a-long-random-string'],
      ['placeholder-bot-token'],
      ['<your-token-here>'],
      ['xxxxxxxx'],
      // 64 hex chars, a valid AES key, and publicly known — worse than absent
      // because it looks safe.
      ['0000000000000000000000000000000000000000000000000000000000000000'],
    ])('treats %s as a placeholder', (value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    });

    /**
     * The far more expensive mistake: rejecting a credential that works. These
     * are shapes real keys and secrets actually take.
     */
    it.each([
      ['sk-ant-api03-abc123XYZ_deadbeef'],
      ['sk-ant-test'],
      ['test-anthropic-key'],
      ['GOCSPX-1a2b3c4d5e6f'],
      ['918273645-abcdefg.apps.googleusercontent.com'],
      ['d9d8a6f1c4b70e2a3d5f8091b2c4e6a7d9d8a6f1c4b70e2a3d5f8091b2c4e6519'],
      ['http://localhost:3000/auth/google/callback'],
      // Contains "your" but is not a placeholder — the pattern is anchored.
      ['secret-for-yourcompany-prod'],
    ])('accepts %s as a real value', (value) => {
      expect(isPlaceholderValue(value)).toBe(false);
    });

    it('reports a placeholder separately from an absence', () => {
      const audit = auditConfig(
        { ...FULL, GOOGLE_CLIENT_ID: 'your-client-id', ANTHROPIC_API_KEY: '' },
        CALENDAR_REQUIRED_VARS,
      );
      expect(audit.missing).toEqual(['ANTHROPIC_API_KEY']);
      expect(audit.placeholder).toEqual(['GOOGLE_CLIENT_ID']);
    });

    it('does not call an empty value a placeholder', () => {
      // Empty is already reported as missing; saying both would be noise.
      expect(isPlaceholderValue('')).toBe(false);
      expect(isPlaceholderValue('   ')).toBe(false);
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
      expect(config.placeholderVars).toEqual([]);
    });

    it('reports unconfigured on a placeholder, and says which kind', () => {
      const config = service({ ANTHROPIC_API_KEY: 'sk-ant-your-key-here' });
      expect(config.isConfigured).toBe(false);
      // Not reported as missing — you can see it in your .env, and being told
      // it is absent sends you hunting for the wrong thing.
      expect(config.missingVars).toEqual([]);
      expect(config.placeholderVars).toEqual(['ANTHROPIC_API_KEY']);
      expect(
        placeholderCalendarConfig({ ...FULL, GOOGLE_CLIENT_ID: 'your-id' }),
      ).toEqual(['GOOGLE_CLIENT_ID']);
    });

    it('does not leak its internal array to callers', () => {
      const config = service({ ANTHROPIC_API_KEY: undefined });
      config.missingVars.push('TAMPERED');
      expect(config.missingVars).toEqual(['ANTHROPIC_API_KEY']);
    });
  });
});
