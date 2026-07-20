import { Injectable, Logger } from '@nestjs/common';
import { joinWrappedLines, normalizeWhitespace } from '../chunker';
import {
  ExtractedDocument,
  UnprocessableDocumentError,
} from './extractor.types';

/**
 * PDF text extraction, via `unpdf`.
 *
 * Chosen over `pdf-parse`, which the spec suggested: pdf-parse is effectively
 * unmaintained and its entry point runs a demo against a bundled test file when
 * imported without arguments, which is a well-known footgun in bundled and
 * containerised builds. `unpdf` wraps Mozilla's actively maintained pdf.js and
 * is packaged for serverless/Node without that behaviour.
 *
 * Scope: text-layer PDFs only. A scanned document is images with no text layer,
 * and extracting it would need OCR — out of scope, but detected and reported
 * honestly rather than ingested as an empty document.
 */
@Injectable()
export class PdfExtractor {
  private readonly logger = new Logger(PdfExtractor.name);

  /**
   * Below this many characters a PDF is treated as having no usable text layer.
   * Scanned pages often yield a handful of stray ligatures rather than nothing
   * at all, so a plain empty check would let them through.
   */
  private static readonly MIN_USABLE_CHARS = 20;

  async extract(data: Buffer, fileName: string): Promise<ExtractedDocument> {
    let text: string;

    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const result = await extractText(pdf, { mergePages: true });
      text = Array.isArray(result.text)
        ? result.text.join('\n\n')
        : result.text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to parse PDF ${fileName}: ${detail}`);

      // Encrypted, corrupt, or not actually a PDF. Retrying cannot help.
      throw new UnprocessableDocumentError(
        `PDF parse failed for ${fileName}: ${detail}`,
        `I couldn't read "${fileName}". It may be password-protected or corrupted.`,
      );
    }

    if (text.trim().length < PdfExtractor.MIN_USABLE_CHARS) {
      throw new UnprocessableDocumentError(
        `PDF ${fileName} yielded ${text.trim().length} characters — no text layer`,
        `"${fileName}" looks like a scanned document — I can only read PDFs that ` +
          "contain real text, not images of text. I don't do OCR yet.",
      );
    }

    return {
      text: joinWrappedLines(normalizeWhitespace(text)),
      sourceType: 'pdf',
      sourceName: fileName,
    };
  }
}
