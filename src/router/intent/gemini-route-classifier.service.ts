import { Injectable, Logger } from '@nestjs/common';
import { formatZonedNow } from '../../common/zoned-time';
import { GeminiClient } from '../../llm/gemini.client';
import {
  ClassifyRouteInput,
  RouteClassifier,
} from './route-classifier.service';
import { ROUTE_SYSTEM_PROMPT } from './route-prompt';
import {
  RoutingDecision,
  narrowRoute,
  routeExtractionJsonSchema,
  routeExtractionSchema,
} from './route-intent.schema';

/**
 * The routing classifier on Gemini.
 *
 * Shares the system prompt and both schemas with the Anthropic implementation —
 * the prompt lives in `route-prompt.ts` precisely so the two cannot drift, since
 * two copies of a prompt is two behaviours, and the eval fixtures only ever
 * exercise one of them.
 *
 * The output contract is identical: Gemini's `responseJsonSchema` takes the
 * same JSON Schema, and the zod schema validates the result the same way. What
 * differs is only the transport.
 */
@Injectable()
export class GeminiRouteClassifier extends RouteClassifier {
  private readonly logger = new Logger(GeminiRouteClassifier.name);

  constructor(private readonly gemini: GeminiClient) {
    super();
  }

  async classify(input: ClassifyRouteInput): Promise<RoutingDecision> {
    const { parsed, finishReason } = await this.gemini.generateStructured({
      system: ROUTE_SYSTEM_PROMPT,
      user: [
        `Current time: ${formatZonedNow(input.now, input.timeZone)}`,
        `User timezone: ${input.timeZone}`,
        '',
        `Message: ${JSON.stringify(input.text)}`,
      ].join('\n'),
      jsonSchema: routeExtractionJsonSchema,
      // Matches the Anthropic ceiling. Gemini bills thinking tokens against
      // this budget, so a tighter limit truncates the answer rather than the
      // reasoning.
      maxOutputTokens: 3072,
    });

    const validated = routeExtractionSchema.safeParse(parsed);

    if (!validated.success) {
      // Fail to `unrelated` rather than guessing a route — same reasoning as
      // the Anthropic path. Dispatching a message we could not read to an agent
      // that then acts on it is the worst outcome available here.
      this.logger.warn(
        `Routing produced no usable output (finishReason=${finishReason}): ${validated.error.message}`,
      );
      return { route: 'unrelated', reason: 'classification failed' };
    }

    const decision = narrowRoute(validated.data);
    this.logger.debug(
      `Routed to ${decision.route} (confidence=${validated.data.confidence}, alternative=${validated.data.alternative}): ${validated.data.reason}`,
    );

    return decision;
  }
}
