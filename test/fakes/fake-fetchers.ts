import {
  FetchedPage,
  UrlFetcher,
} from '../../src/agents/rag/ingestion/url-fetcher.port';
import { TelegramFileDownloader } from '../../src/telegram/outbound/telegram-file.client';
import { UnprocessableDocumentError } from '../../src/agents/rag/ingestion/extractors/extractor.types';

/** Serves saved HTML instead of fetching a real page. */
export class FakeUrlFetcher extends UrlFetcher {
  private readonly pages = new Map<string, FetchedPage>();
  private failure: UnprocessableDocumentError | undefined;

  readonly requested: string[] = [];

  register(url: string, html: string, finalUrl = url): void {
    this.pages.set(url, { html, url: finalUrl });
  }

  failNext(userMessage = "I couldn't reach that page."): void {
    this.failure = new UnprocessableDocumentError(
      'simulated fetch failure',
      userMessage,
    );
  }

  reset(): void {
    this.pages.clear();
    this.failure = undefined;
    this.requested.length = 0;
  }

  async fetch(url: string): Promise<FetchedPage> {
    this.requested.push(url);

    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }

    const page = this.pages.get(url);
    if (!page) {
      throw new UnprocessableDocumentError(
        `No fixture registered for ${url}`,
        `I couldn't reach ${url}.`,
      );
    }
    return page;
  }
}

/** Serves file bytes instead of calling Telegram's file API. */
export class FakeTelegramFileDownloader extends TelegramFileDownloader {
  private readonly files = new Map<string, Buffer>();
  private failure: UnprocessableDocumentError | undefined;

  readonly downloaded: string[] = [];

  register(fileId: string, data: Buffer | string): void {
    this.files.set(
      fileId,
      typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
    );
  }

  failNext(userMessage = "I couldn't download that file."): void {
    this.failure = new UnprocessableDocumentError(
      'simulated download failure',
      userMessage,
    );
  }

  reset(): void {
    this.files.clear();
    this.failure = undefined;
    this.downloaded.length = 0;
  }

  async download(fileId: string, fileName: string): Promise<Buffer> {
    this.downloaded.push(fileId);

    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }

    const data = this.files.get(fileId);
    if (!data) {
      throw new UnprocessableDocumentError(
        `No fixture registered for file ${fileId}`,
        `I couldn't download "${fileName}".`,
      );
    }
    return data;
  }
}
