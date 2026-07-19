import { z } from 'zod';

/**
 * ---------------------------------------------------------------------------
 * The LLM contract.
 * ---------------------------------------------------------------------------
 *
 * Two shapes live here, deliberately:
 *
 *  1. `calendarExtractionSchema` — the FLAT wire schema sent to the model.
 *  2. `CalendarIntent` — the discriminated union the rest of the agent uses.
 *
 * Why not send the union directly? Anthropic's structured outputs support
 * `anyOf`, but a flat object with optional fields is markedly more reliable for
 * a small model, and it degrades better: a model that fills the wrong field for
 * its chosen intent produces a validation miss we can turn into a clarifying
 * question, rather than a schema violation that fails the whole call.
 *
 * `narrowIntent()` below is the bridge — it enforces the per-intent required
 * fields that the flat schema cannot express, so invalid combinations still
 * never escape into the agent.
 */

export const CALENDAR_INTENTS = [
  'create_event',
  'reschedule_event',
  'delete_event',
  'needs_clarification',
  'not_calendar_related',
] as const;

export type CalendarIntentName = (typeof CALENDAR_INTENTS)[number];

/**
 * How the model refers to an existing event. It never sees or invents an event
 * id — we resolve this query against the real calendar ourselves, which is what
 * makes "reschedule my call" with three calls today resolvable rather than a
 * coin flip.
 */
export const eventQuerySchema = z.object({
  titleContains: z
    .string()
    .describe(
      'Distinctive words from the event title, e.g. "dentist". Empty if the user gave no title.',
    ),
  approximateStart: z
    .string()
    .describe(
      'ISO-8601 start of the window to search, or empty string if unknown.',
    ),
  approximateEnd: z
    .string()
    .describe(
      'ISO-8601 end of the window to search, or empty string if unknown.',
    ),
});

export type EventQuery = z.infer<typeof eventQuerySchema>;

/**
 * The flat schema the model fills in.
 *
 * Every field is required at the JSON-schema level (structured outputs handle
 * required-everything far more reliably than sparse optionals); irrelevant
 * fields are filled with empty strings, which `narrowIntent` then treats as
 * absent. Numeric and string length constraints are deliberately omitted —
 * structured outputs does not support them.
 */
export const calendarExtractionSchema = z.object({
  intent: z
    .enum(CALENDAR_INTENTS)
    .describe('Which calendar action the user is asking for.'),

  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('How confident you are in this classification.'),

  // --- create_event -------------------------------------------------------
  title: z
    .string()
    .describe('Event title for create_event. Empty string otherwise.'),
  startTime: z
    .string()
    .describe(
      'ISO-8601 start with timezone offset, for create_event. Empty string otherwise.',
    ),
  endTime: z
    .string()
    .describe(
      'ISO-8601 end with offset. If the user gave no duration, assume one hour. Empty string otherwise.',
    ),
  location: z.string().describe('Event location, or empty string.'),
  description: z.string().describe('Event description, or empty string.'),

  // --- reschedule_event / delete_event ------------------------------------
  eventQuery: eventQuerySchema.describe(
    'How to find the existing event, for reschedule_event and delete_event.',
  ),
  newStartTime: z
    .string()
    .describe(
      'ISO-8601 new start with offset, for reschedule_event. Empty string otherwise.',
    ),
  newEndTime: z
    .string()
    .describe(
      'ISO-8601 new end with offset, for reschedule_event. Empty if the duration should be preserved.',
    ),

  // --- needs_clarification ------------------------------------------------
  clarifyingQuestion: z
    .string()
    .describe(
      'The single question to ask the user, for needs_clarification. Empty string otherwise.',
    ),
});

export type CalendarExtraction = z.infer<typeof calendarExtractionSchema>;

/**
 * The same shape as `calendarExtractionSchema`, expressed as literal JSON
 * Schema — this is what actually goes on the wire to the model.
 *
 * Why two declarations instead of deriving one from the other: the SDK's
 * `zodOutputFormat` helper targets Zod v4, and this project is on Zod v3 (which
 * Phase 1 uses throughout). Rather than upgrade Zod underneath working code for
 * one call site, the wire contract is written out here and Zod is kept for
 * validating the response. `calendar-intent.schema.spec.ts` asserts the two
 * agree, so they cannot drift silently.
 *
 * Constraints deliberately absent: structured outputs rejects `minLength`,
 * `maximum`, and friends. `additionalProperties: false` and an exhaustive
 * `required` are both mandatory.
 */
export const calendarExtractionJsonSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [...CALENDAR_INTENTS],
      description: 'Which calendar action the user is asking for.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident you are in this classification.',
    },
    title: {
      type: 'string',
      description: 'Event title for create_event. Empty string otherwise.',
    },
    startTime: {
      type: 'string',
      description:
        'ISO-8601 start with timezone offset, for create_event. Empty string otherwise.',
    },
    endTime: {
      type: 'string',
      description:
        'ISO-8601 end with offset. If the user gave no duration, assume one hour. Empty string otherwise.',
    },
    location: {
      type: 'string',
      description: 'Event location, or empty string.',
    },
    description: {
      type: 'string',
      description: 'Event description, or empty string.',
    },
    eventQuery: {
      type: 'object',
      description:
        'How to find the existing event, for reschedule_event and delete_event.',
      properties: {
        titleContains: {
          type: 'string',
          description:
            'Distinctive words from the event title, e.g. "dentist". Empty if the user gave no title.',
        },
        approximateStart: {
          type: 'string',
          description:
            'ISO-8601 start of the window to search, or empty string if unknown.',
        },
        approximateEnd: {
          type: 'string',
          description:
            'ISO-8601 end of the window to search, or empty string if unknown.',
        },
      },
      required: ['titleContains', 'approximateStart', 'approximateEnd'],
      additionalProperties: false,
    },
    newStartTime: {
      type: 'string',
      description:
        'ISO-8601 new start with offset, for reschedule_event. Empty string otherwise.',
    },
    newEndTime: {
      type: 'string',
      description:
        'ISO-8601 new end with offset. Empty if the duration should be preserved.',
    },
    clarifyingQuestion: {
      type: 'string',
      description:
        'The single question to ask the user, for needs_clarification. Empty string otherwise.',
    },
  },
  required: [
    'intent',
    'confidence',
    'title',
    'startTime',
    'endTime',
    'location',
    'description',
    'eventQuery',
    'newStartTime',
    'newEndTime',
    'clarifyingQuestion',
  ],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// The domain type the agent actually works with.
// ---------------------------------------------------------------------------

export type CalendarIntent =
  | {
      intent: 'create_event';
      confidence: Confidence;
      title: string;
      startTime: string;
      endTime: string;
      location?: string;
      description?: string;
    }
  | {
      intent: 'reschedule_event';
      confidence: Confidence;
      eventQuery: EventQuery;
      newStartTime: string;
      newEndTime?: string;
    }
  | {
      intent: 'delete_event';
      confidence: Confidence;
      eventQuery: EventQuery;
    }
  | {
      intent: 'needs_clarification';
      confidence: Confidence;
      question: string;
    }
  | { intent: 'not_calendar_related'; confidence: Confidence };

export type Confidence = 'high' | 'medium' | 'low';

const blank = (value: string | undefined): boolean =>
  value === undefined || value.trim() === '';

/**
 * Narrows a flat extraction into the domain union, enforcing the per-intent
 * required fields.
 *
 * When the model picks an intent but omits a field that intent needs, we
 * downgrade to `needs_clarification` rather than guessing. Guessing a time or a
 * title is exactly the failure mode that produces a wrong calendar entry the
 * user has to notice and undo.
 */
export function narrowIntent(raw: CalendarExtraction): CalendarIntent {
  const confidence = raw.confidence;

  switch (raw.intent) {
    case 'create_event': {
      if (blank(raw.title) || blank(raw.startTime) || blank(raw.endTime)) {
        return {
          intent: 'needs_clarification',
          confidence,
          question: 'What should I call it, and when does it start and end?',
        };
      }
      return {
        intent: 'create_event',
        confidence,
        title: raw.title.trim(),
        startTime: raw.startTime,
        endTime: raw.endTime,
        ...(blank(raw.location) ? {} : { location: raw.location.trim() }),
        ...(blank(raw.description)
          ? {}
          : { description: raw.description.trim() }),
      };
    }

    case 'reschedule_event': {
      if (blank(raw.newStartTime) || isEmptyQuery(raw.eventQuery)) {
        return {
          intent: 'needs_clarification',
          confidence,
          question: 'Which event should I move, and to what time?',
        };
      }
      return {
        intent: 'reschedule_event',
        confidence,
        eventQuery: raw.eventQuery,
        newStartTime: raw.newStartTime,
        ...(blank(raw.newEndTime) ? {} : { newEndTime: raw.newEndTime }),
      };
    }

    case 'delete_event': {
      if (isEmptyQuery(raw.eventQuery)) {
        return {
          intent: 'needs_clarification',
          confidence,
          question: 'Which event should I cancel?',
        };
      }
      return { intent: 'delete_event', confidence, eventQuery: raw.eventQuery };
    }

    case 'needs_clarification':
      return {
        intent: 'needs_clarification',
        confidence,
        question: blank(raw.clarifyingQuestion)
          ? 'Could you give me a bit more detail?'
          : raw.clarifyingQuestion.trim(),
      };

    case 'not_calendar_related':
      return { intent: 'not_calendar_related', confidence };
  }
}

/** A query with nothing to search on cannot identify an event. */
function isEmptyQuery(query: EventQuery | undefined): boolean {
  if (!query) return true;
  return (
    blank(query.titleContains) &&
    blank(query.approximateStart) &&
    blank(query.approximateEnd)
  );
}
