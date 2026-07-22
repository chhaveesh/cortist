import { Injectable, Logger } from '@nestjs/common';
import { GeminiClient } from '../../../llm/gemini.client';
import {
  ANSWER_PROMPT,
  AnswerSource,
  RagLlm,
  SUMMARY_PROMPT,
  renderSources,
} from './rag-llm.service';
import {
  DocumentSummary,
  GroundedAnswer,
  documentSummaryJsonSchema,
  documentSummarySchema,
  groundedAnswerJsonSchema,
  groundedAnswerSchema,
} from './rag-intent.schema';

/**
 * The RAG agent's LLM calls on Gemini.
 *
 * Prompts, schemas, truncation, and both failure behaviours are shared with the
 * Anthropic implementation — only the transport differs. The two failure modes
 * are worth restating because they are opposite on purpose:
 *
 *   - A failed *summary* is tolerated. The document is stored and searchable
 *     regardless, so losing the summary must not fail the ingest.
 *   - A failed *answer* fails closed. An unparseable answer must never become
 *     a confident reply; for a second brain, saying nothing beats guessing.
 */
@Injectable()
export class GeminiRagLlm extends RagLlm {
  private readonly logger = new Logger(GeminiRagLlm.name);

  constructor(private readonly gemini: GeminiClient) {
    super();
  }

  async summarize(text: string, sourceName: string): Promise<DocumentSummary> {
    // Head of the document only: a long PDF would blow the context window, and
    // the opening is where title, abstract, and subject almost always live.
    const excerpt = text.slice(0, 12_000);

    const { parsed } = await this.gemini.generateStructured({
      system: SUMMARY_PROMPT,
      user: `Document: ${sourceName}\n\n${excerpt}`,
      jsonSchema: documentSummaryJsonSchema,
      maxOutputTokens: 1024,
    });

    const validated = documentSummarySchema.safeParse(parsed);
    if (!validated.success) {
      this.logger.warn(`Summarisation failed for ${sourceName}`);
      return { summary: '', tags: [] };
    }

    return {
      summary: validated.data.summary,
      tags: validated.data.tags
        .slice(0, 3)
        .map((tag) => tag.toLowerCase().trim()),
    };
  }

  async answer(
    question: string,
    sources: AnswerSource[],
  ): Promise<GroundedAnswer> {
    const { parsed, finishReason } = await this.gemini.generateStructured({
      system: ANSWER_PROMPT,
      user: `Sources:\n\n${renderSources(sources)}\n\n---\n\nQuestion: ${question}`,
      jsonSchema: groundedAnswerJsonSchema,
      maxOutputTokens: 2048,
    });

    const validated = groundedAnswerSchema.safeParse(parsed);
    if (!validated.success) {
      this.logger.warn(
        `Grounded answer produced no usable output (finishReason=${finishReason})`,
      );
      return { answer: '', answered: false, usedSourceIndices: [] };
    }

    return validated.data;
  }
}
