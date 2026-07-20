import {
  AnswerSource,
  RagLlm,
} from '../../src/agents/rag/intent/rag-llm.service';
import {
  DocumentSummary,
  GroundedAnswer,
  RagIntent,
} from '../../src/agents/rag/intent/rag-intent.schema';

/**
 * Scripted stand-in for every LLM call the RAG agent makes.
 *
 * Classification is queued per call (like the calendar agent's fake) so a test
 * drives the exact path it means to. Summarisation and answering have sensible
 * defaults, because most tests care about storage and retrieval rather than
 * prose — but both are overridable for the cases that do.
 */
export class FakeRagLlm extends RagLlm {
  private intents: RagIntent[] = [];
  private summaryResult: DocumentSummary = {
    summary: 'A test document.',
    tags: ['test'],
  };
  private answerResult: GroundedAnswer | undefined;

  readonly classifyCalls: string[] = [];
  readonly summarizeCalls: Array<{ text: string; sourceName: string }> = [];
  readonly answerCalls: Array<{ question: string; sources: AnswerSource[] }> =
    [];

  scriptIntent(...intents: RagIntent[]): void {
    this.intents.push(...intents);
  }

  setSummary(summary: DocumentSummary): void {
    this.summaryResult = summary;
  }

  /** Override the grounded answer — including making the model decline. */
  setAnswer(answer: GroundedAnswer): void {
    this.answerResult = answer;
  }

  reset(): void {
    this.intents = [];
    this.answerResult = undefined;
    this.summaryResult = { summary: 'A test document.', tags: ['test'] };
    this.classifyCalls.length = 0;
    this.summarizeCalls.length = 0;
    this.answerCalls.length = 0;
  }

  async classify(text: string): Promise<RagIntent> {
    this.classifyCalls.push(text);

    const next = this.intents.shift();
    if (!next) {
      // Failing loudly beats a default: an unscripted call means the agent took
      // a path the test did not anticipate.
      throw new Error(
        `FakeRagLlm received an unscripted classify call for: ${JSON.stringify(text)}`,
      );
    }
    return next;
  }

  async summarize(text: string, sourceName: string): Promise<DocumentSummary> {
    this.summarizeCalls.push({ text, sourceName });
    return this.summaryResult;
  }

  async answer(
    question: string,
    sources: AnswerSource[],
  ): Promise<GroundedAnswer> {
    this.answerCalls.push({ question, sources });

    if (this.answerResult) return this.answerResult;

    // Default: answer from the first source and cite it. Enough for tests that
    // care about retrieval and citation plumbing rather than wording.
    return {
      answer: `Based on the sources: ${sources[0]?.content.slice(0, 60) ?? ''}`,
      answered: sources.length > 0,
      usedSourceIndices: sources.length > 0 ? [0] : [],
    };
  }
}
