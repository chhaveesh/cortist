import http from 'node:http';
import https from 'node:https';

/**
 * Fails any test that tries to reach a host outside this machine.
 *
 * "No real Google, Anthropic, or Telegram calls in CI" is supposed to hold
 * structurally, via the fakes bound at the provider tokens. This guard is what
 * proves it instead of assuming it — and it exists because the assumption was
 * once wrong: after the calendar agent was wired into the worker, the e2e tier
 * booted the real module graph and genuinely called api.telegram.org, which
 * only surfaced as a confusing 404 in a timeout.
 *
 * Localhost is allowed — the suite talks to Postgres and Redis on 127.0.0.1.
 */

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '[::1]',
]);

export class ExternalNetworkAccessError extends Error {
  readonly name = 'ExternalNetworkAccessError';

  constructor(host: string, via: string) {
    super(
      `Test attempted a real network call to "${host}" via ${via}. ` +
        'Tests must use the fakes bound at CalendarClient / ' +
        'CalendarIntentClassifier / GoogleOAuthClient / TelegramSenderService. ' +
        'If you added a new outbound dependency, stub it in the harness.',
    );
  }
}

export function isAllowedHost(host: string | undefined | null): boolean {
  if (!host) return true; // a request with no host cannot leave this machine
  return ALLOWED_HOSTS.has(stripPort(host).toLowerCase());
}

/**
 * Removes a trailing `:port`, without mangling bare IPv6.
 *
 * A naive `/:\d+$/` strip turns `::1` into `:` — the last two characters look
 * exactly like a port. Bracketed forms and single-colon hosts are the only
 * cases where a trailing port is unambiguous.
 */
function stripPort(host: string): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1];

  // More than one colon means bare IPv6, which cannot carry a port unbracketed.
  const colons = (host.match(/:/g) ?? []).length;
  if (colons > 1) return host;

  return host.replace(/:\d+$/, '');
}

function hostFrom(args: unknown[]): string | undefined {
  const [first, second] = args;

  if (typeof first === 'string') {
    try {
      return new URL(first).hostname;
    } catch {
      return undefined;
    }
  }
  if (first instanceof URL) return first.hostname;

  const options = (
    typeof first === 'object' && first !== null ? first : second
  ) as { host?: string; hostname?: string } | undefined;

  return options?.hostname ?? options?.host;
}

/** Installs the guard. Call once, before any module under test loads. */
export function installNetworkGuard(): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request | undefined)?.url;

    let host: string | undefined;
    try {
      host = url ? new URL(url).hostname : undefined;
    } catch {
      host = undefined;
    }

    if (!isAllowedHost(host)) {
      // Reject rather than throw synchronously: `fetch` always returns a
      // promise, and a sync throw would surface in callers as an unhandled
      // exception at the call site instead of a normal request failure.
      return Promise.reject(
        new ExternalNetworkAccessError(host as string, 'fetch()'),
      );
    }

    return (originalFetch as typeof fetch)(
      input as RequestInfo,
      init as RequestInit,
    );
  }) as typeof fetch;

  // googleapis (gaxios) goes through the http/https modules, not fetch.
  for (const [name, mod] of [
    ['http', http],
    ['https', https],
  ] as const) {
    const originalRequest = mod.request.bind(mod);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod as any).request = (...args: unknown[]) => {
      const host = hostFrom(args);
      if (!isAllowedHost(host)) {
        throw new ExternalNetworkAccessError(
          host as string,
          `${name}.request()`,
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalRequest as any)(...args);
    };
  }
}
