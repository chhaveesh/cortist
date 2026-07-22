import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import {
  LlmRequestError,
  isRetryableStatus,
  parseRetryAfterSeconds,
} from './llm-error';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface StructuredRequest {
  /** System instruction — the role and rules. */
  system: string;
  /** The user turn. */
  user: string;
  /**
   * A standard JSON Schema. Passed through untouched: Gemini's
   * `responseJsonSchema` accepts the same schemas the Anthropic path uses, so
   * there is deliberately no translation layer to drift out of sync.
   */
  jsonSchema: object;
  maxOutputTokens: number;
}

export interface StructuredResponse {
  /** The parsed object, or null when the model returned nothing usable. */
  parsed: unknown | null;
  finishReason: string;
}

/**
 * Minimal Gemini client for structured generation.
 *
 * Written against `fetch` rather than pulling in `@google/genai`: the surface
 * used here is one endpoint and one response shape, and a dependency that ships
 * its own transport, retry, and auth stack is a poor trade for that. It also
 * keeps the outbound seam obvious, which matters for the test-time network
 * guard.
 */
@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true }) ?? '';
    this.model = config.get('GEMINI_MODEL', { infer: true });
  }

  async generateStructured(
    request: StructuredRequest,
  ): Promise<StructuredResponse> {
    const response = await fetch(`${API_BASE}/${this.model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: request.jsonSchema,
          maxOutputTokens: request.maxOutputTokens,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      const detail = extractErrorMessage(body);
      const retryable = isRetryableStatus(response.status);

      // Logged here rather than at the call site so the provider's own wording
      // survives — "credit balance is too low" is the kind of message that
      // tells you exactly what to do, and paraphrasing it loses that.
      this.logger[retryable ? 'warn' : 'error'](
        `Gemini ${response.status} (${retryable ? 'retryable' : 'not retryable'}): ${detail}`,
      );

      throw new LlmRequestError(
        `Gemini request failed (${response.status})`,
        response.status,
        retryable,
        detail,
        parseRetryAfterSeconds(body),
      );
    }

    const payload = (await response.json()) as GeminiResponse;
    const candidate = payload.candidates?.[0];
    const finishReason = candidate?.finishReason ?? 'UNKNOWN';

    // `parts` can legitimately contain a thought signature alongside the text,
    // so find the text part rather than assuming it is first.
    const text = candidate?.content?.parts?.find(
      (part) => typeof part.text === 'string',
    )?.text;

    if (!text) {
      return { parsed: null, finishReason };
    }

    try {
      return { parsed: JSON.parse(text), finishReason };
    } catch {
      // A truncated response is the usual cause (finishReason MAX_TOKENS), and
      // it produces invalid JSON rather than an error status. Callers fail
      // closed on a null parse, which is the behaviour we want.
      this.logger.warn(
        `Gemini returned unparseable JSON (finishReason=${finishReason})`,
      );
      return { parsed: null, finishReason };
    }
  }
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/** Pulls the human-readable message out of Google's error envelope. */
function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
