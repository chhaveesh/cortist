import { Injectable, Logger } from '@nestjs/common';
import {
  TelegramMessageJob,
  attachmentOf,
} from '../../common/contracts/telegram-message.job';
import { TelegramFileDownloader } from '../../telegram/outbound/telegram-file.client';
import { TelegramSenderService } from '../../telegram/outbound/telegram-sender.service';
import { IngestionService } from './ingestion/ingestion.service';
import {
  ExtractedDocument,
  UnprocessableDocumentError,
} from './ingestion/extractors/extractor.types';
import { HtmlExtractor } from './ingestion/extractors/html.extractor';
import { PdfExtractor } from './ingestion/extractors/pdf.extractor';
import { UrlFetcher } from './ingestion/url-fetcher.port';
import { firstUrlIn } from './intent/rag-keyword-filter';
import { RagLlm } from './intent/rag-llm.service';
import { RagIntent } from './intent/rag-intent.schema';
import { RetrievalService } from './retrieval/retrieval.service';

export type RagAgentOutcome =
  | { status: 'skipped'; reason: 'prefiltered' | 'not_rag_related' }
  | { status: 'ingested'; documentId: string; chunkCount: number }
  | { status: 'answered'; citations: string[] }
  | { status: 'nothing_relevant' }
  | { status: 'rejected'; reason: string };

/** Filenames/mime types we can read. Anything else is refused up front. */
const TEXT_MIME_PREFIXES = ['text/', 'application/json'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json'];

/**
 * The RAG agent — Cortist's second brain.
 *
 * Single public entry point (`handle`), matching CalendarAgentService, so the
 * future router treats every agent the same way. Shares nothing with the
 * calendar agent beyond the queue contract and the tenant model.
 */
@Injectable()
export class RagAgentService {
  private readonly logger = new Logger(RagAgentService.name);

  constructor(
    private readonly llm: RagLlm,
    private readonly ingestion: IngestionService,
    private readonly retrieval: RetrievalService,
    private readonly pdf: PdfExtractor,
    private readonly html: HtmlExtractor,
    private readonly urlFetcher: UrlFetcher,
    private readonly files: TelegramFileDownloader,
    private readonly telegram: TelegramSenderService,
  ) {}

  /**
   * Acts on a message the router has already classified as knowledge work.
   *
   * The agent no longer decides whether a message is its business, and no
   * longer classifies: `intent` arrives pre-extracted from the router's single
   * classification. `null` means an attachment, which needs no classification
   * at all — a PDF upload is unambiguous.
   */
  async handle(
    job: TelegramMessageJob,
    intent: RagIntent | null,
  ): Promise<RagAgentOutcome> {
    const attachment = attachmentOf(job);

    try {
      if (attachment) {
        return await this.ingestAttachment(job, attachment);
      }

      if (!intent) {
        // Nothing to act on and no file: the router should not have sent this.
        this.logger.warn(
          `RAG agent received message ${job.messageId} with no intent and no attachment`,
        );
        return { status: 'skipped', reason: 'not_rag_related' };
      }

      switch (intent.intent) {
        case 'store':
          return await this.ingestText(job, intent.content);
        case 'query':
          return await this.answerQuestion(job, intent.question);
        case 'not_rag_related':
          return { status: 'skipped', reason: 'not_rag_related' };
      }
    } catch (error) {
      // A document the user cannot fix by resending fails identically on
      // retry, so it is reported and the job completes rather than burning
      // three BullMQ attempts and staying silent throughout.
      if (error instanceof UnprocessableDocumentError) {
        this.logger.warn(`Unprocessable document: ${error.message}`);
        await this.say(job, error.userMessage);
        return { status: 'rejected', reason: error.message };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  private async ingestAttachment(
    job: TelegramMessageJob,
    attachment: NonNullable<ReturnType<typeof attachmentOf>>,
  ): Promise<RagAgentOutcome> {
    const fileName = attachment.fileName ?? 'document';

    // Checked before downloading: Telegram refuses bot downloads above 20MB
    // anyway, so spending the request would only produce a worse error.
    if (
      attachment.fileSize !== undefined &&
      attachment.fileSize > 20 * 1024 * 1024
    ) {
      await this.say(
        job,
        `"${fileName}" is too large — I can handle files up to 20 MB.`,
      );
      return { status: 'rejected', reason: 'file too large' };
    }

    const kind = this.classifyFile(fileName, attachment.mimeType);
    if (!kind) {
      await this.say(
        job,
        `I can't read "${fileName}" — I handle PDFs and plain text files.`,
      );
      return { status: 'rejected', reason: `unsupported type ${fileName}` };
    }

    const data = await this.files.download(attachment.fileId, fileName);

    const document: ExtractedDocument =
      kind === 'pdf'
        ? await this.pdf.extract(data, fileName)
        : {
            text: data.toString('utf8'),
            sourceType: 'text',
            sourceName: fileName,
          };

    return this.finishIngestion(job, document);
  }

  private async ingestText(
    job: TelegramMessageJob,
    content: string,
  ): Promise<RagAgentOutcome> {
    // A message that is mostly a link means "remember this page", not
    // "remember this sentence containing a link".
    const url = firstUrlIn(content);

    if (url) {
      const page = await this.urlFetcher.fetch(url);
      const document = await this.html.extract(page.html, page.url);
      return this.finishIngestion(job, document);
    }

    return this.finishIngestion(job, {
      text: content,
      sourceType: 'text',
      // Pasted text has no filename, so label it with its own opening words.
      sourceName: this.labelFor(content),
    });
  }

  private async finishIngestion(
    job: TelegramMessageJob,
    document: ExtractedDocument,
  ): Promise<RagAgentOutcome> {
    const result = await this.ingestion.ingest(job.tenantId, document);

    const tagLine =
      result.tags.length > 0 ? `\n\nTags: ${result.tags.join(', ')}` : '';
    const summaryLine = result.summary ? `\n\n${result.summary}` : '';

    await this.say(
      job,
      `📚 Saved "${result.sourceName}" (${result.chunkCount} ` +
        `${result.chunkCount === 1 ? 'section' : 'sections'}).${summaryLine}${tagLine}`,
    );

    return {
      status: 'ingested',
      documentId: result.documentId,
      chunkCount: result.chunkCount,
    };
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  private async answerQuestion(
    job: TelegramMessageJob,
    question: string,
  ): Promise<RagAgentOutcome> {
    const outcome = await this.retrieval.answer(job.tenantId, question);

    switch (outcome.status) {
      case 'no_documents':
        await this.say(
          job,
          "I don't have anything saved yet. Send me a document or say " +
            '"save this: ..." and I\'ll remember it.',
        );
        return { status: 'nothing_relevant' };

      case 'nothing_relevant':
        // Deliberately not answered from general knowledge. A second brain that
        // invents an answer is worse than one that admits the gap.
        await this.say(
          job,
          "I couldn't find anything relevant in what you've saved, so I'd " +
            'rather not guess.',
        );
        return { status: 'nothing_relevant' };

      case 'answered': {
        const sources = outcome.citations.map((name) => `• ${name}`).join('\n');
        await this.say(job, `${outcome.answer}\n\nSources:\n${sources}`);
        return { status: 'answered', citations: outcome.citations };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private classifyFile(
    fileName: string,
    mimeType?: string,
  ): 'pdf' | 'text' | null {
    const lower = fileName.toLowerCase();

    if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';

    if (
      (mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) ||
      TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
    ) {
      return 'text';
    }

    return null;
  }

  private labelFor(content: string): string {
    const firstLine = content.split('\n')[0].trim();
    return firstLine.length > 60
      ? `${firstLine.slice(0, 57)}...`
      : firstLine || 'Saved note';
  }

  private async say(job: TelegramMessageJob, text: string): Promise<void> {
    await this.telegram.sendMessage(job.chatId, text);
  }
}
