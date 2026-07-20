import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingClient,
  EmbeddingInputType,
} from './embedding.port';

/** Loaded lazily so importing this file never pulls in the ONNX runtime. */
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export const LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Embeddings computed on this machine, with no API key and no network call at
 * inference time.
 *
 * Chosen over a hosted provider because Anthropic has no embeddings API, and a
 * second brain is exactly the workload where you may not want every stored
 * document leaving your infrastructure. The tradeoff is real: retrieval quality
 * is below a current hosted model, and the first load costs ~10s and ~100MB of
 * model weights.
 *
 * The model is loaded **once per process** and reused. Loading per request
 * would add that ~10s to every message.
 */
@Injectable()
export class LocalEmbeddingClient
  extends EmbeddingClient
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(LocalEmbeddingClient.name);

  /**
   * The in-flight or completed load. Held as a promise, not a value, so
   * concurrent first calls await one load rather than starting several.
   */
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  async embed(
    texts: string[],
    _inputType: EmbeddingInputType,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extract = await this.load();

    // `normalize: true` returns unit vectors, which is what lets the vector
    // store treat cosine distance and inner product as equivalent.
    const output = await extract(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist();

    // Guard the invariant the schema depends on: the column is vector(384), so
    // a model producing anything else fails at insert time with a far more
    // confusing error than this one.
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding model returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
        );
      }
    }

    return vectors;
  }

  private load(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.logger.log(
        `Loading local embedding model ${LOCAL_EMBEDDING_MODEL} (first call only, takes a few seconds)`,
      );

      const startedAt = Date.now();

      // Dynamic import keeps the ONNX runtime out of the gateway process, which
      // never embeds anything.
      this.pipelinePromise = import('@huggingface/transformers')
        .then(({ pipeline }) =>
          pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL),
        )
        .then((extractor) => {
          this.logger.log(
            `Embedding model ready in ${Date.now() - startedAt}ms`,
          );
          return extractor as unknown as FeatureExtractionPipeline;
        })
        .catch((error: unknown) => {
          // Clear the cached promise so a transient failure (no network on the
          // very first run) does not permanently poison the client.
          this.pipelinePromise = undefined;
          throw error;
        });
    }

    return this.pipelinePromise;
  }

  onApplicationShutdown(): void {
    this.pipelinePromise = undefined;
  }
}
