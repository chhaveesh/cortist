import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { Env } from '../../config/env.schema';
import {
  RoutingDecision,
  narrowRoute,
  routeExtractionJsonSchema,
  routeExtractionSchema,
} from './route-intent.schema';

export interface ClassifyRouteInput {
  text: string;
  /** The user's calendar timezone, so relative times resolve correctly. */
  timeZone: string;
  now: Date;
}

/**
 * The single classification step. Abstract so tests bind a scripted fake and no
 * real API call happens in CI.
 */
export abstract class RouteClassifier {
  abstract classify(input: ClassifyRouteInput): Promise<RoutingDecision>;
}

const SYSTEM_PROMPT = `You route a message sent to a personal assistant, and extract the details needed to act on it — in a single step.

Routes:
- calendar: create, move, or cancel a calendar event.
- rag_ingest: the user wants something remembered — "save this", "remember this", a pasted URL, a note to keep.
- rag_query: a question that should be answered from documents the user previously saved ("what did that report say about X", "what do I know about Y").
- unrelated: anything else — chit-chat, general knowledge questions, or requests this assistant cannot do.

Rules:
- Resolve every relative time ("tomorrow", "next Tuesday", "in an hour") into an absolute ISO-8601 timestamp WITH the user's UTC offset, using the current time and timezone given to you.
- A general knowledge question the user could ask any assistant ("what is the capital of France") is NOT rag_query. rag_query means the answer should come from THEIR saved material. Prefer unrelated when unsure.
- For reschedule and delete you never know event IDs. Describe the event with eventQuery instead.
- Set "alternative" to the genuinely next-most-plausible route, or "none" when no other route is plausible. Be honest here: a message like "remind me about the report" really could be a calendar reminder or a question about a saved document, and saying so is more useful than picking one confidently.
- Set confidence to "high" only when you would not expect a reasonable person to disagree.
- Fill every field. Use an empty string for fields that do not apply to your chosen route.`;

@Injectable()
export class AnthropicRouteClassifier extends RouteClassifier {
  private readonly logger = new Logger(AnthropicRouteClassifier.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.client = new Anthropic({
      apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }),
    });
    this.model = config.get('ANTHROPIC_MODEL', { infer: true });
  }

  async classify(input: ClassifyRouteInput): Promise<RoutingDecision> {
    const response = await this.client.messages.parse({
      model: this.model,
      // Larger than the agents' old ceilings because this schema carries both
      // agents' fields, but still a bounded extraction task.
      max_tokens: 3072,
      system: SYSTEM_PROMPT,
      output_config: {
        format: jsonSchemaOutputFormat(routeExtractionJsonSchema),
      },
      messages: [
        {
          role: 'user',
          content: [
            `Current time: ${input.now.toISOString()}`,
            `User timezone: ${input.timeZone}`,
            '',
            `Message: ${JSON.stringify(input.text)}`,
          ].join('\n'),
        },
      ],
    });

    const parsed = routeExtractionSchema.safeParse(response.parsed_output);

    if (!parsed.success) {
      // Fail to `unrelated` rather than guessing a route. Dispatching a message
      // we could not read to an agent that then acts on it is the worst
      // outcome available here.
      this.logger.warn(
        `Routing produced no usable output (stop_reason=${response.stop_reason}): ${parsed.error.message}`,
      );
      return {
        route: 'unrelated',
        reason: 'classification failed',
      };
    }

    const decision = narrowRoute(parsed.data);
    this.logger.debug(
      `Routed to ${decision.route} (confidence=${parsed.data.confidence}, alternative=${parsed.data.alternative}): ${parsed.data.reason}`,
    );

    return decision;
  }
}
