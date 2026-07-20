import { CalendarIntent } from '../../src/agents/calendar/intent/calendar-intent.schema';
export interface ClassifyInput {
  text: string;
  timeZone: string;
  now: Date;
}

/**
 * Supplies calendar intents to agent-focused tests.
 *
 * Since Phase 4a the calendar agent no longer classifies — the router hands it
 * a pre-extracted intent — so this is a plain test helper rather than a bound
 * provider. It stands in for the router's extraction so those suites can keep
 * testing conflict detection, confirmation, and tenant behaviour directly.
 */
export class ScriptedIntentClassifier {
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
