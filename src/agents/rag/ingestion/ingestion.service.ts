import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingClient } from '../embedding/embedding.port';
import { RagLlm } from '../intent/rag-llm.service';
import { VectorStoreService } from '../retrieval/vector-store.service';
import { chunkText } from './chunker';
import { ExtractedDocument } from './extractors/extractor.types';

export interface IngestionResult {
  documentId: string;
  chunkCount: number;
  summary: string;
  tags: string[];
  sourceName: string;
}

/**
 * extract → chunk → embed → summarise → store.
 *
 * Extraction happens before this service is called, so ingestion is identical
 * whether the text came from a PDF, a web page, or a pasted message.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly llm: RagLlm,
    private readonly store: VectorStoreService,
  ) {}

  async ingest(
    tenantId: string,
    document: ExtractedDocument,
  ): Promise<IngestionResult> {
    const chunks = chunkText(document.text);

    if (chunks.length === 0) {
      throw new Error(`Nothing to ingest from ${document.sourceName}`);
    }

    this.logger.log(
      `Ingesting ${document.sourceName} for tenant ${tenantId}: ${chunks.length} chunks`,
    );

    // Embedding and summarising are independent, so they run concurrently —
    // the summary is over the whole document, not per chunk, so it does not
    // depend on chunking having finished meaningfully.
    const [embeddings, summary] = await Promise.all([
      this.embeddings.embed(chunks, 'document'),
      this.llm.summarize(document.text, document.sourceName),
    ]);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count ${embeddings.length} does not match chunk count ${chunks.length}`,
      );
    }

    const stored = await this.store.storeDocument({
      userId: tenantId,
      sourceType: document.sourceType,
      sourceName: document.sourceName,
      summary: summary.summary,
      tags: summary.tags,
      chunks: chunks.map((content, index) => ({
        content,
        chunkIndex: index,
        embedding: embeddings[index],
      })),
    });

    return {
      documentId: stored.documentId,
      chunkCount: stored.chunkCount,
      summary: summary.summary,
      tags: summary.tags,
      sourceName: document.sourceName,
    };
  }
}
