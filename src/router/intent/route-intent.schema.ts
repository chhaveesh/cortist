import { z } from 'zod';
import {
  CalendarIntent,
  eventQuerySchema,
  narrowIntent,
} from '../../agents/calendar/intent/calendar-intent.schema';
import {
  RagIntent,
  narrowRagIntent,
} from '../../agents/rag/intent/rag-intent.schema';

/**
 * ---------------------------------------------------------------------------
 * The router contract: one classification per message.
 * ---------------------------------------------------------------------------
 *
 * This schema does routing AND extraction in a single call. That is a
 * deliberate trade, and the cost is real: the router's schema now contains
 * every agent's fields, so adding an agent widens it. Two calls (route, then
 * let the agent extract) would keep the router thin but pay two LLM round trips
 * for every routed message.
 *
 * The compensating design is that the agents still own the *meaning* of their
 * fields — this file imports their schemas and their narrowing functions rather
 * than restating them, so an agent's extraction rules live in one place and the
 * router cannot drift from them.
 */

export const ROUTES = [
  'calendar',
  'rag_query',
  'rag_ingest',
  'unrelated',
] as const;

export type RouteName = (typeof ROUTES)[number];

export const CALENDAR_ACTIONS = [
  'create_event',
  'reschedule_event',
  'delete_event',
  'needs_clarification',
] as const;

/** Flat wire schema — same reasoning as the agents': all fields required. */
export const routeExtractionSchema = z.object({
  route: z.enum(ROUTES).describe('Which agent should handle this message.'),

  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('How confident you are in the route.'),

  /**
   * The runner-up.
   *
   * A bare confidence score says *that* the model hesitated; the runner-up says
   * *between what*, which is what lets the clarifying question name both
   * options instead of asking a vague "what did you mean?".
   */
  alternative: z
    .enum([...ROUTES, 'none'])
    .describe(
      'The next most plausible route, or "none" if no other route is plausible.',
    ),

  reason: z.string().describe('One short sentence explaining the route.'),

  // --- calendar extraction (route=calendar) --------------------------------
  calendarAction: z
    .enum(CALENDAR_ACTIONS)
    .describe('Which calendar action, when route=calendar.'),
  title: z.string().describe('Event title for create_event, else empty.'),
  startTime: z
    .string()
    .describe('ISO-8601 start with offset for create_event, else empty.'),
  endTime: z
    .string()
    .describe(
      'ISO-8601 end with offset. Assume one hour if no duration was given. Else empty.',
    ),
  location: z.string().describe('Event location, or empty.'),
  description: z.string().describe('Event description, or empty.'),
  eventQuery: eventQuerySchema.describe(
    'How to find an existing event, for reschedule and delete.',
  ),
  newStartTime: z
    .string()
    .describe('ISO-8601 new start for reschedule, else empty.'),
  newEndTime: z
    .string()
    .describe('ISO-8601 new end for reschedule. Empty preserves the duration.'),
  clarifyingQuestion: z
    .string()
    .describe('Question to ask when calendarAction=needs_clarification.'),

  // --- rag extraction (route=rag_ingest / rag_query) ------------------------
  contentToStore: z
    .string()
    .describe(
      'For rag_ingest: the text or URL to remember, WITHOUT the trigger phrase. Else empty.',
    ),
  question: z
    .string()
    .describe('For rag_query: the question to answer. Else empty.'),
});

export type RouteExtraction = z.infer<typeof routeExtractionSchema>;

/** The JSON Schema actually sent to the model. See the agents' note on why both. */
export const routeExtractionJsonSchema = {
  type: 'object',
  properties: {
    route: {
      type: 'string',
      enum: [...ROUTES],
      description: 'Which agent should handle this message.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    alternative: {
      type: 'string',
      enum: [...ROUTES, 'none'],
      description:
        'The next most plausible route, or "none" if no other route is plausible.',
    },
    reason: {
      type: 'string',
      description: 'One short sentence explaining the route.',
    },
    calendarAction: {
      type: 'string',
      enum: [...CALENDAR_ACTIONS],
      description: 'Which calendar action, when route=calendar.',
    },
    title: {
      type: 'string',
      description: 'Event title for create_event, else empty.',
    },
    startTime: {
      type: 'string',
      description: 'ISO-8601 start with offset for create_event, else empty.',
    },
    endTime: {
      type: 'string',
      description:
        'ISO-8601 end with offset. Assume one hour if no duration was given. Else empty.',
    },
    location: { type: 'string', description: 'Event location, or empty.' },
    description: {
      type: 'string',
      description: 'Event description, or empty.',
    },
    eventQuery: {
      type: 'object',
      description: 'How to find an existing event, for reschedule and delete.',
      properties: {
        titleContains: {
          type: 'string',
          description:
            'Distinctive words from the event title, e.g. "dentist". Empty if none given.',
        },
        approximateStart: {
          type: 'string',
          description: 'ISO-8601 start of the search window, or empty.',
        },
        approximateEnd: {
          type: 'string',
          description: 'ISO-8601 end of the search window, or empty.',
        },
      },
      required: ['titleContains', 'approximateStart', 'approximateEnd'],
      additionalProperties: false,
    },
    newStartTime: {
      type: 'string',
      description: 'ISO-8601 new start for reschedule, else empty.',
    },
    newEndTime: {
      type: 'string',
      description:
        'ISO-8601 new end for reschedule. Empty preserves the duration.',
    },
    clarifyingQuestion: {
      type: 'string',
      description: 'Question to ask when calendarAction=needs_clarification.',
    },
    contentToStore: {
      type: 'string',
      description:
        'For rag_ingest: the text or URL to remember, WITHOUT the trigger phrase. Else empty.',
    },
    question: {
      type: 'string',
      description: 'For rag_query: the question to answer. Else empty.',
    },
  },
  required: [
    'route',
    'confidence',
    'alternative',
    'reason',
    'calendarAction',
    'title',
    'startTime',
    'endTime',
    'location',
    'description',
    'eventQuery',
    'newStartTime',
    'newEndTime',
    'clarifyingQuestion',
    'contentToStore',
    'question',
  ],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// The domain type the router works with.
// ---------------------------------------------------------------------------

export type RoutingDecision =
  | { route: 'calendar'; intent: CalendarIntent; reason: string }
  | { route: 'rag_query'; intent: RagIntent; reason: string }
  | { route: 'rag_ingest'; intent: RagIntent; reason: string }
  | { route: 'unrelated'; reason: string }
  | {
      route: 'ambiguous';
      /** The two candidates, so the question can name them. */
      between: [RouteName, RouteName];
      reason: string;
    };

/**
 * Is this classification too uncertain to act on?
 *
 * **Ambiguous ⟺ confidence is not high AND a different alternative exists.**
 *
 * Both halves matter. Low confidence with no alternative means the model is
 * unsure it understood at all — asking "did you mean A or B?" is useless when
 * there is no B, so that case routes anyway and the agent's own clarification
 * handles it. A named alternative at high confidence means the model saw a
 * second reading and dismissed it, which is exactly the judgement we want it to
 * make rather than escalating to the user.
 *
 * The threshold is a UX dial: loosening it interrupts users more often,
 * tightening it misroutes more often. See DECISIONS.md §46.
 */
export function isAmbiguous(raw: RouteExtraction): boolean {
  return (
    raw.confidence !== 'high' &&
    raw.alternative !== 'none' &&
    raw.alternative !== raw.route
  );
}

/**
 * Narrows the flat extraction into a routing decision, delegating each agent's
 * field rules to that agent's own narrowing function.
 */
export function narrowRoute(raw: RouteExtraction): RoutingDecision {
  if (isAmbiguous(raw)) {
    return {
      route: 'ambiguous',
      between: [raw.route, raw.alternative as RouteName],
      reason: raw.reason,
    };
  }

  switch (raw.route) {
    case 'calendar':
      return {
        route: 'calendar',
        // Reuses the calendar agent's own narrowing, so its rules — including
        // downgrading an incomplete request to a clarifying question — apply
        // identically whether the fields came from the router or the agent.
        intent: narrowIntent({
          intent: raw.calendarAction,
          confidence: raw.confidence,
          title: raw.title,
          startTime: raw.startTime,
          endTime: raw.endTime,
          location: raw.location,
          description: raw.description,
          eventQuery: raw.eventQuery,
          newStartTime: raw.newStartTime,
          newEndTime: raw.newEndTime,
          clarifyingQuestion: raw.clarifyingQuestion,
        }),
        reason: raw.reason,
      };

    case 'rag_ingest':
      return {
        route: 'rag_ingest',
        intent: narrowRagIntent({
          intent: 'store',
          confidence: raw.confidence,
          contentToStore: raw.contentToStore,
          question: '',
        }),
        reason: raw.reason,
      };

    case 'rag_query':
      return {
        route: 'rag_query',
        intent: narrowRagIntent({
          intent: 'query',
          confidence: raw.confidence,
          contentToStore: '',
          question: raw.question,
        }),
        reason: raw.reason,
      };

    case 'unrelated':
      return { route: 'unrelated', reason: raw.reason };
  }
}

/** Human-readable label for a route, used in clarifying questions. */
export function describeRoute(route: RouteName): string {
  switch (route) {
    case 'calendar':
      return 'something with your calendar';
    case 'rag_query':
      return 'a question about your saved documents';
    case 'rag_ingest':
      return 'saving something to your notes';
    case 'unrelated':
      return 'something else';
  }
}
