import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.schema';
import { EmbeddingClient } from '../embedding/embedding.port';
import { RagLlm } from '../intent/rag-llm.service';
import { SimilarChunk, VectorStoreService } from './vector-store.service';

export type RetrievalOutcome =
  | { status: 'no_documents' }
  | { status: 'nothing_relevant'; bestSimilarity: number | null }
  | {
      status: 'answered';
      answer: string;
      citations: string[];
      chunksConsidered: number;
    };

/**
 * Question → answer, grounded in this tenant's documents.
 *
 * Two honesty gates stand between a question and a reply, because for a second
 * brain a confident wrong answer is worse than no answer:
 *
 *   1. A similarity floor, before the LLM is called at all. Vector search
 *      always returns its nearest neighbours — even when the nearest thing is
 *      unrelated — so without a floor an empty-ish knowledge base yields
 *      irrelevant chunks that read as authoritative context.
 *   2. The model's own `answered` flag, so it can decline even when the chunks
 *      cleared the floor but do not actually contain the answer.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  private readonly topK: number;
  private readonly threshold: number;

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly store: VectorStoreService,
    private readonly llm: RagLlm,
    config: ConfigService<Env, true>,
  ) {
    this.topK = config.get('RAG_TOP_K', { infer: true });
    this.threshold = config.get('RAG_SIMILARITY_THRESHOLD', { infer: true });
  }

  async answer(tenantId: string, question: string): Promise<RetrievalOutcome> {
    // Distinguish "you have saved nothing" from "nothing matched" — they need
    // very different replies.
    if ((await this.store.countChunks(tenantId)) === 0) {
      return { status: 'no_documents' };
    }

    const queryEmbedding = await this.embeddings.embedOne(question, 'query');

    // Tenant scoping lives inside the store; every query there filters by
    // user_id. See VectorStoreService.
    const matches = await this.store.searchSimilar(
      tenantId,
      queryEmbedding,
      this.topK,
    );

    const relevant = matches.filter(
      (match) => match.similarity >= this.threshold,
    );

    if (relevant.length === 0) {
      const best = matches[0]?.similarity ?? null;
      this.logger.log(
        `No chunk cleared the ${this.threshold} threshold for tenant ${tenantId} (best ${best ?? 'n/a'})`,
      );
      return { status: 'nothing_relevant', bestSimilarity: best };
    }

    const answer = await this.llm.answer(
      question,
      relevant.map((match) => ({
        sourceName: match.sourceName,
        content: match.content,
      })),
    );

    // The model declined. Report that rather than passing its empty answer on.
    if (!answer.answered || answer.answer.trim().length === 0) {
      return {
        status: 'nothing_relevant',
        bestSimilarity: relevant[0]?.similarity ?? null,
      };
    }

    return {
      status: 'answered',
      answer: answer.answer.trim(),
      citations: this.citationsFor(relevant, answer.usedSourceIndices),
      chunksConsidered: relevant.length,
    };
  }

  /**
   * Names of the documents actually used, de-duplicated.
   *
   * Falls back to every retrieved source when the model returns no usable
   * indices — an answer with a slightly over-broad citation is far better than
   * one with no attribution, which is the whole point of the feature.
   */
  private citationsFor(
    chunks: SimilarChunk[],
    usedIndices: number[],
  ): string[] {
    const valid = usedIndices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < chunks.length,
    );

    const selected = valid.length > 0 ? valid.map((i) => chunks[i]) : chunks;

    return [...new Set(selected.map((chunk) => chunk.sourceName))];
  }
}
