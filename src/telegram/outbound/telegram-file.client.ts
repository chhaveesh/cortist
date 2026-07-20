import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { UnprocessableDocumentError } from '../../agents/rag/ingestion/extractors/extractor.types';

/**
 * Telegram's own hard limit for bot downloads. Files above this cannot be
 * fetched by a bot at all, however the code is written — so it is checked
 * before spending a request.
 */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Downloading an uploaded file is a network call, so it sits behind a port and
 * is faked in tests.
 */
export abstract class TelegramFileDownloader {
  abstract download(fileId: string, fileName: string): Promise<Buffer>;
}

/**
 * Two-step download, as Telegram requires: `getFile` resolves a `file_id` to a
 * temporary `file_path`, then the file is fetched from the file endpoint.
 * The path expires, which is why it is resolved at download time rather than
 * stored on the queue.
 */
@Injectable()
export class TelegramFileClient extends TelegramFileDownloader {
  private readonly logger = new Logger(TelegramFileClient.name);
  private readonly botToken: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.botToken = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  }

  async download(fileId: string, fileName: string): Promise<Buffer> {
    const filePath = await this.resolvePath(fileId, fileName);

    const response = await fetch(
      `https://api.telegram.org/file/bot${this.botToken}/${filePath}`,
    );

    if (!response.ok) {
      throw new UnprocessableDocumentError(
        `Telegram file download failed (${response.status}) for ${fileId}`,
        `I couldn't download "${fileName}". Try sending it again.`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.byteLength > TELEGRAM_MAX_DOWNLOAD_BYTES) {
      throw new UnprocessableDocumentError(
        `Downloaded file ${fileName} is ${buffer.byteLength} bytes`,
        `"${fileName}" is too large — I can handle files up to 20 MB.`,
      );
    }

    this.logger.debug(`Downloaded ${fileName} (${buffer.byteLength} bytes)`);
    return buffer;
  }

  private async resolvePath(fileId: string, fileName: string): Promise<string> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/getFile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      },
    );

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    } | null;

    if (!response.ok || !body?.ok || !body.result?.file_path) {
      // Telegram reports the over-20MB case here, before any bytes move.
      throw new UnprocessableDocumentError(
        `getFile failed for ${fileId}: ${body?.description ?? response.status}`,
        `I couldn't fetch "${fileName}" from Telegram. Files over 20 MB can't be ` +
          'downloaded by bots.',
      );
    }

    return body.result.file_path;
  }
}
