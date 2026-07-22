import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatZonedNow } from '../../common/zoned-time';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { Env } from '../../config/env.schema';
import { ROUTE_SYSTEM_PROMPT } from './route-prompt';
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
      system: ROUTE_SYSTEM_PROMPT,
      output_config: {
        format: jsonSchemaOutputFormat(routeExtractionJsonSchema),
      },
      messages: [
        {
          role: 'user',
          content: [
            `Current time: ${formatZonedNow(input.now, input.timeZone)}`,
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
