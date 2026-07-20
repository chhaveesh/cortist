import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { EMBEDDING_DIMENSIONS } from '../embedding/embedding.port';

export interface ChunkToStore {
  content: string;
  chunkIndex: number;
  embedding: number[];
}

export interface SimilarChunk {
  chunkId: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  sourceName: string;
  sourceType: string;
  /** Cosine similarity in [0, 1] — higher is more similar. */
  similarity: number;
}

/**
 * The only place raw vector SQL lives.
 *
 * Concentrated deliberately. Prisma has no vector type, so these queries are
 * hand-written, and a hand-written query is exactly where a missing
 * `WHERE user_id = ...` would hide. Keeping them in one small file makes the
 * tenant isolation boundary auditable by reading a single page rather than
 * trusting a convention spread across the agent.
 *
 * **Every query in this file filters by user_id. That is a correctness
 * requirement, not a style rule** — without it one user's second brain answers
 * questions from another's documents.
 */
@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert a document and its chunks in one transaction.
   *
   * Atomic on purpose: a document row with no chunks is invisible to search but
   * shows up in listings, and orphaned chunks would be attributed to a document
   * that does not exist.
   */
  async storeDocument(input: {
    userId: string;
    sourceType: string;
    sourceName: string;
    summary: string;
    tags: string[];
    chunks: ChunkToStore[];
  }): Promise<{ documentId: string; chunkCount: number }> {
    for (const chunk of input.chunks) {
      if (chunk.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Chunk ${chunk.chunkIndex} has ${chunk.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          userId: input.userId,
          sourceType: input.sourceType,
          sourceName: input.sourceName,
          summary: input.summary,
          tags: input.tags,
        },
      });

      for (const chunk of input.chunks) {
        // Raw SQL because Prisma cannot write a vector column. The vector is
        // interpolated as a parameter, never string-concatenated.
        await tx.$executeRaw`
          INSERT INTO document_chunks
            (id, document_id, user_id, content, chunk_index, embedding, created_at)
          VALUES (
            gen_random_uuid(),
            ${document.id}::uuid,
            ${input.userId}::uuid,
            ${chunk.content},
            ${chunk.chunkIndex},
            ${this.toVector(chunk.embedding)}::vector,
            NOW()
          )
        `;
      }

      return { documentId: document.id, chunkCount: input.chunks.length };
    });
  }

  /**
   * Find the chunks most similar to `embedding`, **within one tenant**.
   *
   * `<=>` is pgvector's cosine distance (0 = identical, 2 = opposite), so
   * similarity is `1 - distance`. The embedding model returns unit vectors, so
   * cosine and inner product would rank identically; cosine is clearer.
   */
  async searchSimilar(
    userId: string,
    embedding: number[],
    limit: number,
  ): Promise<SimilarChunk[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Query embedding has ${embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }

    // Coerced and validated rather than trusted.
    //
    // Prisma binds a raw-query parameter using its JS type, so a `limit` that
    // arrived as a string — from an env var read without coercion, say —
    // reaches Postgres as text and the query dies with
    // "argument of LIMIT must be type bigint, not type text". That error names
    // neither the parameter nor the caller. The config layer coerces this
    // today, but this method is public and the failure is too obscure to leave
    // to convention.
    const safeLimit = Number(limit);
    if (!Number.isInteger(safeLimit) || safeLimit < 1) {
      throw new Error(
        `Search limit must be a positive integer, got ${JSON.stringify(limit)}`,
      );
    }

    // Iterative scan makes a filtered HNSW search keep looking until it has
    // enough rows that actually match the filter. Without it, the index scan
    // finds K global nearest neighbours and *then* drops other tenants' rows —
    // returning fewer results than asked for, or none, purely because a
    // different tenant's documents happened to be closer. Correctness here does
    // not depend on the index being used at all: with no index Postgres does an
    // exact scan, which is right by construction.
    await this.prisma.$executeRawUnsafe(
      `SET LOCAL hnsw.iterative_scan = 'relaxed_order'`,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{
        chunk_id: string;
        document_id: string;
        content: string;
        chunk_index: number;
        source_name: string;
        source_type: string;
        distance: number;
      }>
    >`
      SELECT
        c.id            AS chunk_id,
        c.document_id   AS document_id,
        c.content       AS content,
        c.chunk_index   AS chunk_index,
        d.source_name   AS source_name,
        d.source_type   AS source_type,
        c.embedding <=> ${this.toVector(embedding)}::vector AS distance
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.user_id = ${userId}::uuid
      ORDER BY c.embedding <=> ${this.toVector(embedding)}::vector
      LIMIT ${safeLimit}
    `;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      content: row.content,
      chunkIndex: row.chunk_index,
      sourceName: row.source_name,
      sourceType: row.source_type,
      // Cosine distance is in [0, 2]; clamp so float error cannot yield
      // a similarity marginally above 1 or below 0.
      similarity: Math.min(1, Math.max(0, 1 - Number(row.distance))),
    }));
  }

  async countChunks(userId: string): Promise<number> {
    return this.prisma.documentChunk.count({ where: { userId } });
  }

  async listDocuments(userId: string) {
    return this.prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * pgvector's text input format: `[0.1,0.2,...]`.
   *
   * Non-finite values are rejected here because `NaN` would serialize to the
   * literal string `NaN` and be silently accepted by the column, poisoning
   * every later distance computation against that row.
   */
  private toVector(embedding: number[]): string {
    for (const value of embedding) {
      if (!Number.isFinite(value)) {
        throw new Error('Embedding contains a non-finite value');
      }
    }
    return `[${embedding.join(',')}]`;
  }
}
