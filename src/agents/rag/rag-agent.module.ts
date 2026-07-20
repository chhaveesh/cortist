import { Module } from '@nestjs/common';
import {
  TelegramFileClient,
  TelegramFileDownloader,
} from '../../telegram/outbound/telegram-file.client';
import { TelegramOutboundModule } from '../../telegram/outbound/telegram-outbound.module';
import { EmbeddingClient } from './embedding/embedding.port';
import { LocalEmbeddingClient } from './embedding/local-embedding.client';
import { HtmlExtractor } from './ingestion/extractors/html.extractor';
import { PdfExtractor } from './ingestion/extractors/pdf.extractor';
import { IngestionService } from './ingestion/ingestion.service';
import { HttpUrlFetcher, UrlFetcher } from './ingestion/url-fetcher.port';
import { AnthropicRagLlm, RagLlm } from './intent/rag-llm.service';
import { RagAgentService } from './rag-agent.service';
import { RetrievalService } from './retrieval/retrieval.service';
import { VectorStoreService } from './retrieval/vector-store.service';

/**
 * The RAG agent, self-contained and independent of the calendar agent — they
 * share only the Phase 1 queue contract and the tenant model.
 *
 * Four abstract tokens are bound here, and those four are the entire surface
 * tests replace: EmbeddingClient, RagLlm, UrlFetcher, TelegramFileDownloader.
 * Nothing else in this module can reach the network.
 */
@Module({
  imports: [TelegramOutboundModule],
  providers: [
    RagAgentService,
    IngestionService,
    RetrievalService,
    VectorStoreService,
    PdfExtractor,
    HtmlExtractor,
    { provide: EmbeddingClient, useClass: LocalEmbeddingClient },
    { provide: RagLlm, useClass: AnthropicRagLlm },
    { provide: UrlFetcher, useClass: HttpUrlFetcher },
    { provide: TelegramFileDownloader, useClass: TelegramFileClient },
  ],
  exports: [RagAgentService],
})
export class RagAgentModule {}
