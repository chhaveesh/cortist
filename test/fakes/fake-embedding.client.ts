import { createHash } from 'node:crypto';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingClient,
  EmbeddingInputType,
} from '../../src/agents/rag/embedding/embedding.port';

/**
 * Deterministic embeddings for tests.
 *
 * Two problems this solves. First, the real model is ~100MB and ~10s to load —
 * unacceptable in a test suite. Second, and more important: real embeddings
 * make similarity assertions depend on what a neural network happens to think
 * two sentences mean, so a test asserting "these should match" is really
 * asserting a model's semantics and will drift when the model changes.
 *
 * Instead, similarity here is **controllable**. Register related texts under a
 * shared topic and they embed near each other; anything unregistered lands in a
 * deterministic pseudo-random direction, far from everything.
 */
export class FakeEmbeddingClient extends EmbeddingClient {
  /** text → topic. Texts sharing a topic embed close together. */
  private readonly topics = new Map<string, string>();

  readonly calls: Array<{ texts: string[]; inputType: EmbeddingInputType }> =
    [];

  /**
   * Declare that these texts are about the same thing, so they retrieve each
   * other. Substring matching, so a chunk containing a registered phrase
   * inherits its topic — which is what makes chunked documents testable.
   */
  register(topic: string, ...texts: string[]): void {
    for (const text of texts) this.topics.set(text.toLowerCase(), topic);
  }

  reset(): void {
    this.topics.clear();
    this.calls.length = 0;
  }

  async embed(
    texts: string[],
    inputType: EmbeddingInputType,
  ): Promise<number[][]> {
    this.calls.push({ texts, inputType });
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const lower = text.toLowerCase();

    // A chunk counts as on-topic if it contains a registered phrase, or a
    // registered phrase contains it.
    let topic: string | undefined;
    for (const [phrase, candidate] of this.topics) {
      if (lower.includes(phrase) || phrase.includes(lower)) {
        topic = candidate;
        break;
      }
    }

    // Same topic → same base direction, so cosine similarity is ~1. Unknown
    // text → its own direction seeded from the text itself, so it is stable
    // across runs but unrelated to everything else.
    return this.unitVectorFromSeed(topic ?? `unrelated:${lower}`);
  }

  /**
   * A deterministic unit vector derived from a seed string. Hash bytes are
   * stretched to fill the dimension, then L2-normalized so the store's cosine
   * arithmetic behaves exactly as it does with real embeddings.
   */
  private unitVectorFromSeed(seed: string): number[] {
    const digest = createHash('sha256').update(seed).digest();

    const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => {
      const byte = digest[i % digest.length];
      const jitter = digest[(i * 7 + 3) % digest.length];
      return (byte - 128) / 128 + (jitter - 128) / 4096;
    });

    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return values.map((v) => v / norm);
  }
}
