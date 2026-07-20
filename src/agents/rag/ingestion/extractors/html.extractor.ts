import { Injectable, Logger } from '@nestjs/common';
import { joinWrappedLines, normalizeWhitespace } from '../chunker';
import {
  ExtractedDocument,
  UnprocessableDocumentError,
} from './extractor.types';

/**
 * Turns a web page into readable text.
 *
 * Uses Mozilla's Readability — the algorithm behind Firefox Reader View — which
 * identifies the article body and discards navigation, sidebars, cookie
 * banners, and footers. Embedding raw HTML would fill the vector store with
 * boilerplate that is identical across every page from a site, which is exactly
 * the content most likely to match a query for the wrong reasons.
 *
 * Parsing is separated from fetching so the whole thing is testable against a
 * saved HTML fixture without touching the network.
 */
@Injectable()
export class HtmlExtractor {
  private readonly logger = new Logger(HtmlExtractor.name);

  private static readonly MIN_USABLE_CHARS = 50;

  /**
   * @param html raw page source
   * @param url  used as the document base (so relative links resolve) and as
   *             the stored source name
   */
  async extract(html: string, url: string): Promise<ExtractedDocument> {
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');

    let title: string | undefined;
    let text: string;

    try {
      // `url` matters: Readability resolves relative URLs against it, and jsdom
      // rejects some documents without a base.
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();

      if (article?.textContent && article.textContent.trim().length > 0) {
        title = article.title ?? undefined;
        text = article.textContent;
      } else {
        // Readability declines on pages that are not articles — a search
        // results page, a dashboard. Fall back to the body text rather than
        // giving up, since some of those are still worth remembering.
        this.logger.debug(
          `Readability found no article at ${url}; using body text`,
        );
        text = dom.window.document.body?.textContent ?? '';
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UnprocessableDocumentError(
        `HTML parse failed for ${url}: ${detail}`,
        `I couldn't read the page at ${url}.`,
      );
    }

    if (text.trim().length < HtmlExtractor.MIN_USABLE_CHARS) {
      // Typically a client-rendered app whose HTML is an empty shell.
      throw new UnprocessableDocumentError(
        `Page ${url} yielded ${text.trim().length} characters`,
        `There wasn't much readable text at ${url} — it may need JavaScript to ` +
          'load its content, which I cannot run.',
      );
    }

    return {
      // Normalized here rather than left to the chunker: this text also feeds
      // summarisation, and HTML source indentation is not part of the content.
      // Wrapped lines are rejoined so a sentence split across source lines
      // reads as one sentence.
      text: joinWrappedLines(normalizeWhitespace(text)),
      sourceType: 'url',
      // Prefer the article title; the bare URL is a poor citation label.
      sourceName: title?.trim() ? `${title.trim()} (${url})` : url,
    };
  }
}
