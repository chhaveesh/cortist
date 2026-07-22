import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { GeminiClient } from '../../llm/gemini.client';
import { LlmModule } from '../../llm/llm.module';
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
import { GeminiRagLlm } from './intent/gemini-rag-llm.service';
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
  imports: [TelegramOutboundModule, LlmModule],
  providers: [
    RagAgentService,
    IngestionService,
    RetrievalService,
    VectorStoreService,
    PdfExtractor,
    HtmlExtractor,
    { provide: EmbeddingClient, useClass: LocalEmbeddingClient },
    {
      // Same provider switch as the router's, bound separately so the two
      // could differ if there were ever a reason — grounded answering and
      // routing have different quality requirements.
      provide: RagLlm,
      inject: [ConfigService, GeminiClient],
      useFactory: (config: ConfigService<Env, true>, gemini: GeminiClient) =>
        config.get('LLM_PROVIDER', { infer: true }) === 'gemini'
          ? new GeminiRagLlm(gemini)
          : new AnthropicRagLlm(config),
    },
    { provide: UrlFetcher, useClass: HttpUrlFetcher },
    { provide: TelegramFileDownloader, useClass: TelegramFileClient },
  ],
  exports: [RagAgentService],
})
export class RagAgentModule {}
