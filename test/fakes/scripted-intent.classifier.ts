import { CalendarIntent } from '../../src/agents/calendar/intent/calendar-intent.schema';
import {
  CalendarIntentClassifier,
  ClassifyInput,
} from '../../src/agents/calendar/intent/calendar-intent.service';

/**
 * A classifier that returns whatever the test told it to.
 *
 * Bound to the `CalendarIntentClassifier` token, this is what keeps Anthropic
 * out of CI. It also records each `ClassifyInput`, so tests can assert that the
 * agent passed the right timezone and current time — the two things the model
 * needs to resolve "tomorrow at 3pm" correctly.
 */
export class ScriptedIntentClassifier extends CalendarIntentClassifier {
  private queue: CalendarIntent[] = [];
  readonly received: ClassifyInput[] = [];

  /** Queue one intent per expected call, in order. */
  script(...intents: CalendarIntent[]): void {
    this.queue.push(...intents);
  }

  reset(): void {
    this.queue = [];
    this.received.length = 0;
  }

  get callCount(): number {
    return this.received.length;
  }

  async classify(input: ClassifyInput): Promise<CalendarIntent> {
    this.received.push(input);

    const next = this.queue.shift();
    if (!next) {
      // Failing loudly beats returning a default — an unscripted call means the
      // agent took a path the test did not anticipate, which is worth knowing.
      throw new Error(
        `ScriptedIntentClassifier received an unscripted call for: ${JSON.stringify(
          input.text,
        )}`,
      );
    }

    return next;
  }
}
