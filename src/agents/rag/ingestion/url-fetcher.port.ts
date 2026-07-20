import { Injectable } from '@nestjs/common';
import { UnprocessableDocumentError } from './extractors/extractor.types';

export interface FetchedPage {
  html: string;
  /** Final URL after redirects — what should be cited. */
  url: string;
}

/**
 * Fetching a URL is a network call, so it sits behind a port and gets faked in
 * tests. Without this the suite would depend on a third-party site being up and
 * unchanged.
 */
export abstract class UrlFetcher {
  abstract fetch(url: string): Promise<FetchedPage>;
}

/** Pages larger than this are refused rather than chunked into oblivion. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

@Injectable()
export class HttpUrlFetcher extends UrlFetcher {
  async fetch(url: string): Promise<FetchedPage> {
    let response: Response;

    try {
      response = await fetch(url, {
        redirect: 'follow',
        headers: {
          // Some sites serve a bot-blocking page to unknown agents; a plain
          // identifier gets the readable version more often than none at all.
          'User-Agent': 'Cortist/1.0 (personal knowledge assistant)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UnprocessableDocumentError(
        `Fetch failed for ${url}: ${detail}`,
        `I couldn't reach ${url}.`,
      );
    }

    if (!response.ok) {
      throw new UnprocessableDocumentError(
        `Fetch for ${url} returned ${response.status}`,
        `${url} returned an error (${response.status}), so there was nothing to save.`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      throw new UnprocessableDocumentError(
        `Unsupported content-type ${contentType} at ${url}`,
        `${url} isn't a web page I can read (it's ${contentType.split(';')[0]}).`,
      );
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PAGE_BYTES) {
      throw new UnprocessableDocumentError(
        `Page ${url} declares ${declaredLength} bytes`,
        `The page at ${url} is too large for me to process.`,
      );
    }

    const html = await response.text();

    // Re-check after reading: content-length is optional and can lie.
    if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
      throw new UnprocessableDocumentError(
        `Page ${url} exceeded ${MAX_PAGE_BYTES} bytes after download`,
        `The page at ${url} is too large for me to process.`,
      );
    }

    return { html, url: response.url || url };
  }
}
