/**
 * The embedding seam.
 *
 * Everything that turns text into a vector goes through here, which is what
 * keeps the model out of CI: tests bind a deterministic fake, so similarity
 * behaviour is predictable rather than dependent on what a real model happens
 * to think two sentences mean.
 */

/** Dimension of the vectors this system stores. Fixed by the migration. */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Retrieval quality improves when the model knows whether it is embedding a
 * stored document or a search query — several providers prepend different
 * instructions for each. Kept in the port even though the local model ignores
 * it, so swapping in a provider that cares needs no call-site changes.
 */
export type EmbeddingInputType = 'document' | 'query';

export abstract class EmbeddingClient {
  /**
   * Embed a batch of texts.
   *
   * Batched rather than one-at-a-time because ingestion embeds every chunk of a
   * document at once, and per-item calls would dominate the cost.
   *
   * Implementations must return **L2-normalized** vectors, in input order, of
   * length EMBEDDING_DIMENSIONS. Normalization is what lets the store treat
   * cosine distance and inner product interchangeably.
   */
  abstract embed(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<number[][]>;

  /** Convenience for the single-text case (a search query). */
  async embedOne(
    text: string,
    inputType: EmbeddingInputType,
  ): Promise<number[]> {
    const [vector] = await this.embed([text], inputType);
    return vector;
  }
}
