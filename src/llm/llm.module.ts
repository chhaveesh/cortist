import { Module } from '@nestjs/common';
import { GeminiClient } from './gemini.client';

/**
 * The Gemini transport, shared by the router and the RAG agent.
 *
 * Imported explicitly by the two consumers rather than made global: the client
 * has exactly two call sites, and an explicit import documents that. The
 * provider *choice* lives at each binding site (`router.module.ts`,
 * `rag-agent.module.ts`), so the two could diverge if there were ever a reason.
 */
@Module({
  providers: [GeminiClient],
  exports: [GeminiClient],
})
export class LlmModule {}
