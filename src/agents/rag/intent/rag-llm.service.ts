import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { Env } from '../../../config/env.schema';
import {
  DocumentSummary,
  GroundedAnswer,
  documentSummaryJsonSchema,
  documentSummarySchema,
  groundedAnswerJsonSchema,
  groundedAnswerSchema,
} from './rag-intent.schema';

export interface AnswerSource {
  sourceName: string;
  content: string;
}

/**
 * Every LLM call the RAG agent makes, behind one abstract class so tests bind a
 * single fake instead of three.
 */
export abstract class RagLlm {
  /** One summary + tags per document, over the full text — not per chunk. */
  abstract summarize(
    text: string,
    sourceName: string,
  ): Promise<DocumentSummary>;

  /** Answers strictly from `sources`, or reports that it cannot. */
  abstract answer(
    question: string,
    sources: AnswerSource[],
  ): Promise<GroundedAnswer>;
}

export const ANSWER_PROMPT = `You answer questions using ONLY the sources provided. This is a personal knowledge base, where a confident wrong answer is far worse than admitting the answer is not there.

Rules:
- Use only the numbered sources given. Never use outside knowledge, and never guess.
- If the sources do not contain the answer, set answered=false and leave answer empty. Do not partially answer from general knowledge.
- When you do answer, list the indices of the sources you actually used.
- Be concise and factual.`;

export const SUMMARY_PROMPT =
  'Summarise the document in one paragraph and give 2-3 short lowercase topic tags.';

/**
 * Renders sources as the numbered list the answer prompt refers to.
 *
 * Shared with the Gemini implementation: the indices the model returns in
 * `usedSourceIndices` are positions in THIS rendering, so the two providers
 * must number sources identically or a citation points at the wrong document.
 */
export function renderSources(sources: AnswerSource[]): string {
  return sources
    .map(
      (source, index) =>
        `[${index}] from "${source.sourceName}":\n${source.content}`,
    )
    .join('\n\n---\n\n');
}

@Injectable()
export class AnthropicRagLlm extends RagLlm {
  private readonly logger = new Logger(AnthropicRagLlm.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.client = new Anthropic({
      apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }),
    });
    this.model = config.get('ANTHROPIC_MODEL', { infer: true });
  }

  async summarize(text: string, sourceName: string): Promise<DocumentSummary> {
    // Summarise the head of the document rather than all of it: a long PDF
    // would blow the context window, and the opening is where title, abstract,
    // and subject almost always live.
    const excerpt = text.slice(0, 12_000);

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      system: SUMMARY_PROMPT,
      output_config: {
        format: jsonSchemaOutputFormat(documentSummaryJsonSchema),
      },
      messages: [
        {
          role: 'user',
          content: `Document: ${sourceName}\n\n${excerpt}`,
        },
      ],
    });

    const parsed = documentSummarySchema.safeParse(response.parsed_output);
    if (!parsed.success) {
      // A missing summary must not fail the ingest — the document itself is
      // stored and searchable regardless.
      this.logger.warn(`Summarisation failed for ${sourceName}`);
      return { summary: '', tags: [] };
    }

    return {
      summary: parsed.data.summary,
      tags: parsed.data.tags.slice(0, 3).map((tag) => tag.toLowerCase().trim()),
    };
  }

  async answer(
    question: string,
    sources: AnswerSource[],
  ): Promise<GroundedAnswer> {
    const rendered = renderSources(sources);

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 2048,
      system: ANSWER_PROMPT,
      output_config: {
        format: jsonSchemaOutputFormat(groundedAnswerJsonSchema),
      },
      messages: [
        {
          role: 'user',
          content: `Sources:\n\n${rendered}\n\n---\n\nQuestion: ${question}`,
        },
      ],
    });

    const parsed = groundedAnswerSchema.safeParse(response.parsed_output);
    if (!parsed.success) {
      // Fail closed. An unparseable answer must not become a confident reply.
      this.logger.warn(
        `Grounded answer produced no usable output (stop_reason=${response.stop_reason})`,
      );
      return { answer: '', answered: false, usedSourceIndices: [] };
    }

    return parsed.data;
  }
}
