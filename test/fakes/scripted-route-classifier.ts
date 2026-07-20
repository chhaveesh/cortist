import {
  ClassifyRouteInput,
  RouteClassifier,
} from '../../src/router/intent/route-classifier.service';
import {
  RouteExtraction,
  RoutingDecision,
  narrowRoute,
} from '../../src/router/intent/route-intent.schema';

/**
 * Scripted stand-in for the router's single LLM call.
 *
 * Takes raw *extractions* rather than finished decisions, so the real
 * `narrowRoute` — including its ambiguity rule and both agents' field rules —
 * runs in tests exactly as it does in production. Scripting decisions directly
 * would bypass the logic most worth exercising.
 */
export class ScriptedRouteClassifier extends RouteClassifier {
  private queue: RouteExtraction[] = [];
  readonly received: ClassifyRouteInput[] = [];

  /**
   * What to do with a call the test did not script.
   *
   * Default is to throw, so a router test that takes an unanticipated path
   * fails loudly. Suites that boot the whole worker but are not testing routing
   * (the Phase 1 pipe test, for instance) pass a `defaultRoute` instead, so an
   * incidental classification does not fail an unrelated assertion.
   */
  constructor(private readonly defaultRoute?: RouteExtraction['route']) {
    super();
  }

  script(...extractions: Array<Partial<RouteExtraction>>): void {
    for (const partial of extractions) {
      this.queue.push({
        route: 'unrelated',
        confidence: 'high',
        alternative: 'none',
        reason: 'scripted',
        calendarAction: 'create_event',
        title: '',
        startTime: '',
        endTime: '',
        location: '',
        description: '',
        eventQuery: {
          titleContains: '',
          approximateStart: '',
          approximateEnd: '',
        },
        newStartTime: '',
        newEndTime: '',
        clarifyingQuestion: '',
        contentToStore: '',
        question: '',
        ...partial,
      });
    }
  }

  reset(): void {
    this.queue = [];
    this.received.length = 0;
  }

  get callCount(): number {
    return this.received.length;
  }

  async classify(input: ClassifyRouteInput): Promise<RoutingDecision> {
    this.received.push(input);

    const next = this.queue.shift();

    if (!next && this.defaultRoute) {
      this.script({ route: this.defaultRoute });
      return narrowRoute(this.queue.shift() as RouteExtraction);
    }

    if (!next) {
      // Loud, like the other scripted fakes: an unscripted call means the
      // router took a path the test did not anticipate.
      throw new Error(
        `ScriptedRouteClassifier received an unscripted call for: ${JSON.stringify(input.text)}`,
      );
    }

    return narrowRoute(next);
  }
}
