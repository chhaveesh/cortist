/** Where an ingested document came from. */
export type DocumentSourceType = 'pdf' | 'text' | 'url';

export interface ExtractedDocument {
  text: string;
  sourceType: DocumentSourceType;
  /** Filename, URL, or a short label for pasted text. */
  sourceName: string;
}

/**
 * A failure the user caused and can fix — an unreadable PDF, an oversized file,
 * a page that is all JavaScript.
 *
 * Distinguished from an ordinary Error because retrying is pointless: the same
 * input fails identically every time. The agent reports these to the user and
 * discards the job rather than burning three BullMQ attempts.
 */
export class UnprocessableDocumentError extends Error {
  readonly name = 'UnprocessableDocumentError';

  constructor(
    message: string,
    /** Shown to the user, so it must be plain language. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}
