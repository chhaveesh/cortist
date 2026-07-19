import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { Env } from '../../../config/env.schema';
import {
  CalendarIntent,
  calendarExtractionJsonSchema,
  calendarExtractionSchema,
  narrowIntent,
} from './calendar-intent.schema';

export interface ClassifyInput {
  text: string;
  /** The user's calendar timezone, e.g. "Europe/London". */
  timeZone: string;
  /** "Now" in the user's timezone — anchors relative phrases like "tomorrow". */
  now: Date;
}

/**
 * Abstract so the agent depends on the capability, not on Anthropic. The
 * integration tests bind a scripted fake to this token; swapping providers
 * later means one new implementation, not a rewrite of the agent.
 */
export abstract class CalendarIntentClassifier {
  abstract classify(input: ClassifyInput): Promise<CalendarIntent>;
}

const SYSTEM_PROMPT = `You classify a single message from a personal-assistant user as a calendar action, and extract the details needed to carry it out.

Rules:
- Resolve every relative time ("tomorrow", "next Tuesday", "in an hour") into an absolute ISO-8601 timestamp WITH the user's UTC offset, using the current time and timezone given to you.
- If the user gives a start but no duration for a new event, assume one hour.
- For reschedule and delete, you never know event IDs. Describe the event with eventQuery instead: distinctive title words, and the time window to search.
- Choose needs_clarification when the request is genuinely ambiguous — for example "move my call" when the user plausibly has several calls, or a new event with no stated time. Ask exactly one question.
- Choose not_calendar_related for anything that is not about creating, moving, or cancelling a calendar event. Questions merely mentioning time are not calendar actions.
- Fill every field. Use an empty string for fields that do not apply to your chosen intent.`;

@Injectable()
export class AnthropicCalendarIntentClassifier extends CalendarIntentClassifier {
  private readonly logger = new Logger(AnthropicCalendarIntentClassifier.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.client = new Anthropic({
      apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }),
    });
    this.model = config.get('ANTHROPIC_MODEL', { infer: true });
  }

  async classify(input: ClassifyInput): Promise<CalendarIntent> {
    const response = await this.client.messages.parse({
      model: this.model,
      // Classification with a handful of short string fields — a small ceiling
      // is right here, and keeps a runaway generation from burning tokens.
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      output_config: {
        format: jsonSchemaOutputFormat(calendarExtractionJsonSchema),
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

    // Re-validate with zod rather than trusting `parsed_output` directly. The
    // API guarantees schema conformance, but this is the boundary where an
    // external system's output enters our domain — and it is what keeps the
    // wire schema and the zod schema honest about each other.
    const parsed = calendarExtractionSchema.safeParse(response.parsed_output);

    if (!parsed.success) {
      // A null or non-conforming output means the model refused or hit the
      // token ceiling. Asking beats guessing at someone's calendar.
      this.logger.warn(
        `Intent extraction produced no usable output (stop_reason=${response.stop_reason}): ${parsed.error.message}`,
      );
      return {
        intent: 'needs_clarification',
        confidence: 'low',
        question: "Sorry — I didn't follow that. Could you rephrase it?",
      };
    }

    const intent = narrowIntent(parsed.data);
    this.logger.debug(
      `Classified as ${intent.intent} (confidence=${intent.confidence})`,
    );

    return intent;
  }
}
