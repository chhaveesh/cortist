/**
 * A provider call that failed, and whether trying again could possibly help.
 *
 * The distinction is the point. BullMQ retries three times with backoff, which
 * is right for a blip and pure waste otherwise — and worse than waste, because
 * the user is told nothing for the ~6s it takes to exhaust the attempts, and
 * then still nothing.
 *
 * This was learned the hard way twice in one evening: a placeholder API key
 * (401) and an account with no credit balance (400) were each retried three
 * times and dropped into the failed set silently. Neither was going to succeed
 * on the second attempt. A 429 or a 503 genuinely might.
 */
export class LlmRequestError extends Error {
  readonly name = 'LlmRequestError';

  constructor(
    message: string,
    readonly status: number,
    /** Whether a retry could plausibly succeed. */
    readonly retryable: boolean,
    /** Provider-supplied detail, for the log. */
    readonly detail?: string,
    /**
     * How long the provider asked us to wait, in seconds, when it said so.
     *
     * Worth honouring rather than guessing: a 429 with "retry in 19.8s" against
     * a retry policy that fires at 2s and 4s wastes all three attempts inside
     * the window it was told to wait out, and the user gets silence.
     */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * How long our retry policy keeps trying, in seconds.
 *
 * Three attempts with exponential backoff from 2s lands the last one at roughly
 * 6s (see queue.constants.ts). A provider asking for longer than this cannot be
 * waited out by retrying, so the honest move is to say so now rather than fail
 * silently three times.
 */
export const RETRY_WINDOW_SECONDS = 6;

/** Extracts a retry delay from Google's `RetryInfo` detail or its message. */
export function parseRetryAfterSeconds(body: string): number | undefined {
  // Structured form first: error.details[] carries a RetryInfo with
  // retryDelay: "19s". Fall back to the prose, which is all some errors give.
  try {
    const parsed = JSON.parse(body) as {
      error?: { details?: Array<{ retryDelay?: string }> };
    };
    const delay = parsed.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    if (delay) {
      const seconds = Number.parseFloat(delay);
      if (Number.isFinite(seconds)) return seconds;
    }
  } catch {
    // Not JSON — fall through to the text match.
  }

  const match = /retry in ([\d.]+)\s*s/i.exec(body);
  return match ? Number.parseFloat(match[1]) : undefined;
}

/**
 * Whether an HTTP status from an LLM provider is worth retrying.
 *
 * 429 is the canonical retryable case — the request was fine, the timing was
 * not. 5xx is the provider's problem and usually transient. Everything else in
 * the 4xx range describes something wrong with the request or the account:
 * a bad key, an exhausted balance, a model that does not exist, a payload the
 * API rejects. None of those change within a retry window.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
