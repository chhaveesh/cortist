import { z } from 'zod';

/**
 * The RAG agent's own classifier contract.
 *
 * Deliberately NOT shared with the calendar agent. They classify different
 * things against different vocabularies, and a shared "intent service" would
 * have to know about every agent — which is the router, and the router is a
 * later phase. Sharing now would couple two agents that are supposed to be
 * independent.
 */

export const RAG_INTENTS = ['store', 'query', 'not_rag_related'] as const;
export type RagIntentName = (typeof RAG_INTENTS)[number];

/** Flat wire schema, for the same reasons as the calendar agent's. */
export const ragExtractionSchema = z.object({
  intent: z
    .enum(RAG_INTENTS)
    .describe('What the user wants done with their stored knowledge.'),
  confidence: z.enum(['high', 'medium', 'low']),
  /**
   * For `store` with pasted text: the content to remember, with any trigger
   * phrase removed. Empty otherwise.
   */
  contentToStore: z
    .string()
    .describe(
      'For intent=store on pasted text: the text to remember, WITHOUT the trigger phrase like "save this:". Empty string otherwise.',
    ),
  /** For `query`: the question, cleaned of conversational filler. */
  question: z
    .string()
    .describe(
      'For intent=query: the question to answer from stored documents. Empty string otherwise.',
    ),
});

export type RagExtraction = z.infer<typeof ragExtractionSchema>;

/** JSON Schema sent to the model. See the calendar agent's note on why both. */
export const ragExtractionJsonSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [...RAG_INTENTS],
      description: 'What the user wants done with their stored knowledge.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    contentToStore: {
      type: 'string',
      description:
        'For intent=store on pasted text: the text to remember, WITHOUT the trigger phrase like "save this:". Empty string otherwise.',
    },
    question: {
      type: 'string',
      description:
        'For intent=query: the question to answer from stored documents. Empty string otherwise.',
    },
  },
  required: ['intent', 'confidence', 'contentToStore', 'question'],
  additionalProperties: false,
} as const;

export type RagIntent =
  | { intent: 'store'; confidence: Confidence; content: string }
  | { intent: 'query'; confidence: Confidence; question: string }
  | { intent: 'not_rag_related'; confidence: Confidence };

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Narrows the flat extraction, downgrading to `not_rag_related` when the model
 * picked an intent but gave nothing to act on.
 *
 * Storing an empty document or searching for an empty question both produce
 * confidently useless results, so neither is allowed through.
 */
export function narrowRagIntent(raw: RagExtraction): RagIntent {
  const confidence = raw.confidence;

  switch (raw.intent) {
    case 'store': {
      const content = raw.contentToStore.trim();
      if (content.length === 0)
        return { intent: 'not_rag_related', confidence };
      return { intent: 'store', confidence, content };
    }
    case 'query': {
      const question = raw.question.trim();
      if (question.length === 0)
        return { intent: 'not_rag_related', confidence };
      return { intent: 'query', confidence, question };
    }
    case 'not_rag_related':
      return { intent: 'not_rag_related', confidence };
  }
}

// ---------------------------------------------------------------------------
// Grounded answering
// ---------------------------------------------------------------------------

export const groundedAnswerJsonSchema = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description:
        'The answer, using ONLY the provided sources. Empty string if the sources do not contain the answer.',
    },
    answered: {
      type: 'boolean',
      description:
        'True only if the provided sources genuinely contain the answer. False if you had to guess or use outside knowledge.',
    },
    /** Indices of the sources actually used — drives the citation. */
    usedSourceIndices: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Indices (0-based) of the sources you actually used. Empty if answered is false.',
    },
  },
  required: ['answer', 'answered', 'usedSourceIndices'],
  additionalProperties: false,
} as const;

export const groundedAnswerSchema = z.object({
  answer: z.string(),
  answered: z.boolean(),
  usedSourceIndices: z.array(z.number().int()),
});

export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;

// ---------------------------------------------------------------------------
// Summarisation + tagging
// ---------------------------------------------------------------------------

export const documentSummaryJsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'A one-paragraph summary of the document.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        '2-3 short lowercase topic tags, e.g. "finance", "q4-report".',
    },
  },
  required: ['summary', 'tags'],
  additionalProperties: false,
} as const;

export const documentSummarySchema = z.object({
  summary: z.string(),
  tags: z.array(z.string()),
});

export type DocumentSummary = z.infer<typeof documentSummarySchema>;
