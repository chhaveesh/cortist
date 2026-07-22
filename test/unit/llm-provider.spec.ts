import { ConfigService } from '@nestjs/config';
import { LlmConfigService } from '../../src/config/llm-config.service';
import {
  PROVIDER_KEY_VAR,
  calendarRequiredVars,
  isCalendarConfigured,
} from '../../src/config/env.schema';
import {
  LlmRequestError,
  isRetryableStatus,
  parseRetryAfterSeconds,
} from '../../src/llm/llm-error';
import { routeExtractionJsonSchema } from '../../src/router/intent/route-intent.schema';
import { ROUTE_SYSTEM_PROMPT } from '../../src/router/intent/route-prompt';

function config(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<never, true>;
}

describe('LLM provider selection', () => {
  describe('LlmConfigService', () => {
    it('requires only the active provider’s key', () => {
      // The point of the provider switch: a Gemini deployment must not be
      // reported broken for lacking an Anthropic key it will never call.
      const gemini = new LlmConfigService(
        config({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'AQ.real-key' }),
      );
      expect(gemini.isConfigured).toBe(true);
      expect(gemini.provider).toBe('gemini');
      expect(gemini.keyVar).toBe('GEMINI_API_KEY');
      expect(gemini.missingVars).toEqual([]);
    });

    it('reports the active provider’s key when it is the one missing', () => {
      const gemini = new LlmConfigService(
        config({ LLM_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'sk-ant-real' }),
      );
      expect(gemini.isConfigured).toBe(false);
      // Names GEMINI_API_KEY — naming ANTHROPIC_API_KEY here would send you
      // to fix a key the deployment does not use.
      expect(gemini.missingVars).toEqual(['GEMINI_API_KEY']);
    });

    it('still catches a placeholder, per provider', () => {
      const gemini = new LlmConfigService(
        config({
          LLM_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'your-gemini-key-here',
        }),
      );
      expect(gemini.isConfigured).toBe(false);
      expect(gemini.placeholderVars).toEqual(['GEMINI_API_KEY']);
    });

    it('defaults to gemini when the provider is unset', () => {
      expect(new LlmConfigService(config({})).provider).toBe('gemini');
    });
  });

  describe('calendar credentials follow the provider', () => {
    const BASE = {
      TOKEN_ENCRYPTION_KEY:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
      OAUTH_STATE_SECRET: 'a-sufficiently-long-secret',
    };

    it('counts the gemini key on a gemini deployment', () => {
      expect(calendarRequiredVars('gemini')).toContain('GEMINI_API_KEY');
      expect(calendarRequiredVars('gemini')).not.toContain('ANTHROPIC_API_KEY');

      expect(
        isCalendarConfigured({ ...BASE, GEMINI_API_KEY: 'AQ.key' }, 'gemini'),
      ).toBe(true);
      // An Anthropic key does not satisfy a Gemini deployment.
      expect(
        isCalendarConfigured(
          { ...BASE, ANTHROPIC_API_KEY: 'sk-ant-key' },
          'gemini',
        ),
      ).toBe(false);
    });

    it('maps each provider to exactly one key variable', () => {
      expect(PROVIDER_KEY_VAR).toEqual({
        anthropic: 'ANTHROPIC_API_KEY',
        gemini: 'GEMINI_API_KEY',
      });
    });
  });

  /**
   * The rule learned the hard way: a placeholder key (401) and an exhausted
   * credit balance (400) were each retried three times and dropped silently.
   * Neither could have succeeded on a second attempt.
   */
  describe('retry classification', () => {
    it.each([
      [400, false, 'credit balance too low'],
      [401, false, 'invalid api key'],
      [403, false, 'permission denied'],
      [404, false, 'model not found'],
      [422, false, 'bad payload'],
    ])('treats %i as NOT retryable (%s)', (status, retryable) => {
      expect(isRetryableStatus(status)).toBe(retryable);
    });

    it.each([
      [429, 'rate limited — the request was fine, the timing was not'],
      [500, 'provider fault'],
      [503, 'model overloaded'],
    ])('treats %i as retryable (%s)', (status) => {
      expect(isRetryableStatus(status)).toBe(true);
    });

    it('reads the wait out of Google’s structured RetryInfo', () => {
      const body = JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '19.79s',
            },
          ],
        },
      });
      expect(parseRetryAfterSeconds(body)).toBeCloseTo(19.79);
    });

    it('falls back to the prose when there is no RetryInfo', () => {
      // Some 429s only say it in words.
      expect(
        parseRetryAfterSeconds('Quota exceeded. Please retry in 17.28s.'),
      ).toBeCloseTo(17.28);
    });

    it('returns undefined when no wait was given', () => {
      expect(parseRetryAfterSeconds('{"error":{"code":500}}')).toBeUndefined();
    });

    it('carries the provider’s own wording through', () => {
      // "credit balance is too low" tells you exactly what to do; a paraphrase
      // loses that, so the detail is preserved rather than reworded.
      const error = new LlmRequestError(
        'Gemini request failed (400)',
        400,
        false,
        'Your credit balance is too low to access the API.',
      );
      expect(error.retryable).toBe(false);
      expect(error.detail).toMatch(/credit balance/);
      expect(error).toBeInstanceOf(Error);
    });
  });

  /**
   * Both provider implementations share one prompt and one schema. Two copies
   * would be two behaviours, and `eval:router` only ever exercises whichever is
   * bound — so a drift would surface as a routing bug with no obvious cause.
   */
  describe('shared prompt and schema', () => {
    it('exposes one routing prompt for every provider', () => {
      expect(ROUTE_SYSTEM_PROMPT).toContain('You route a message');
      expect(ROUTE_SYSTEM_PROMPT).toContain('rag_query');
    });

    it('uses a schema Gemini accepts unmodified', () => {
      // Gemini's responseJsonSchema takes standard JSON Schema, which is why
      // there is no translation layer here to drift out of sync. These are the
      // properties that would break if one were introduced.
      const schema = routeExtractionJsonSchema as unknown as {
        type: string;
        properties: Record<string, { type: string; enum?: string[] }>;
        required?: string[];
      };
      expect(schema.type).toBe('object');
      expect(schema.properties.route.enum).toContain('calendar');
      expect(schema.properties.confidence.enum).toEqual([
        'high',
        'medium',
        'low',
      ]);
    });
  });
});
