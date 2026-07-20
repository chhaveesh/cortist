/**
 * Manual intent-parser evaluation against the REAL Anthropic API.
 *
 * Deliberately NOT part of the automated suite: it costs money, needs a key,
 * and its assertions are judgement calls rather than invariants. But the
 * automated tests use a scripted classifier, which means the model's actual
 * behaviour — especially whether it asks instead of guessing on an ambiguous
 * request — is otherwise never exercised. This is how you check that.
 *
 *   npm run eval:intent            # run every fixture
 *   npm run eval:intent -- ambiguous   # only fixtures tagged "ambiguous"
 *
 * Exit code is non-zero if any fixture whose expectation is CLEAR fails, so it
 * can gate a release check. Ambiguous fixtures are reported but never fail the
 * run — reasonable people disagree about them, and the output is there to be
 * read, not to be green.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AnthropicCalendarIntentClassifier } from '../src/agents/calendar/intent/calendar-intent.service';
import { CalendarIntentName } from '../src/agents/calendar/intent/calendar-intent.schema';
import { looksCalendarRelated } from '../src/agents/calendar/intent/calendar-keyword-filter';

config({ path: resolve(__dirname, '..', '.env') });

interface Fixture {
  text: string;
  /** What a careful human would expect. */
  expect: CalendarIntentName;
  /** Ambiguous fixtures report but never fail the run. */
  ambiguous?: boolean;
  tags?: string[];
  note?: string;
}

const TIMEZONE = 'Europe/London';
/** Fixed so "tomorrow" is reproducible between runs. */
const NOW = new Date('2026-07-20T09:00:00+01:00'); // a Monday

const FIXTURES: Fixture[] = [
  // --- clear create ------------------------------------------------------
  {
    text: 'book a dentist appointment tomorrow at 3pm',
    expect: 'create_event',
  },
  { text: 'put lunch with Sam in for Friday at noon', expect: 'create_event' },
  {
    text: 'schedule a 30 minute sync with Priya on Wednesday morning',
    expect: 'create_event',
  },

  // --- clear reschedule --------------------------------------------------
  {
    text: 'move my dentist appointment to 5pm',
    expect: 'reschedule_event',
  },
  {
    text: 'push the Priya sync back an hour',
    expect: 'reschedule_event',
    tags: ['relative'],
  },

  // --- clear delete ------------------------------------------------------
  { text: 'cancel my dentist appointment', expect: 'delete_event' },
  { text: 'delete the standup on Thursday', expect: 'delete_event' },

  // --- clear non-calendar ------------------------------------------------
  { text: 'what is the capital of France?', expect: 'not_calendar_related' },
  {
    text: 'can you summarise this article for me',
    expect: 'not_calendar_related',
  },
  {
    text: 'what time is it in Tokyo right now?',
    expect: 'not_calendar_related',
    note: 'Mentions time but asks nothing of the calendar.',
  },
  {
    text: 'am I free to ask you a question?',
    expect: 'not_calendar_related',
    note: 'Contains "free" — a pre-filter keyword — but is not a calendar request.',
  },

  // --- ambiguous: the cases worth reading carefully ----------------------
  {
    text: 'reschedule my call',
    expect: 'reschedule_event',
    ambiguous: true,
    tags: ['ambiguous', 'vague-title'],
    note: 'No new time given. Either needs_clarification, or reschedule with an eventQuery and the agent asks after resolving multiple matches. Both are defensible.',
  },
  {
    text: 'move it to next Tuesday',
    expect: 'needs_clarification',
    ambiguous: true,
    tags: ['ambiguous', 'relative', 'vague-title'],
    note: '"it" has no referent in a single message. Check the resolved date really is the NEXT Tuesday relative to NOW, not today.',
  },
  {
    text: 'cancel the thing on Friday',
    expect: 'delete_event',
    ambiguous: true,
    tags: ['ambiguous', 'vague-title'],
    note: 'Vague title, clear-ish window. Should produce an eventQuery, not a guess at a specific event.',
  },
  {
    text: 'book something for 9',
    expect: 'needs_clarification',
    ambiguous: true,
    tags: ['ambiguous', 'timezone', 'am-pm'],
    note: '9am or 9pm? Which day? Guessing here books a real event at the wrong time.',
  },
  {
    text: 'set up a meeting at 3 for the New York folks',
    expect: 'needs_clarification',
    ambiguous: true,
    tags: ['ambiguous', 'timezone'],
    note: '3pm whose time? A model that silently assumes the calendar timezone is wrong half the time.',
  },
  {
    text: 'shift my morning around',
    expect: 'needs_clarification',
    ambiguous: true,
    tags: ['ambiguous'],
    note: 'Not actionable at all. Should ask.',
  },
  {
    text: 'same time next week please',
    expect: 'needs_clarification',
    ambiguous: true,
    tags: ['ambiguous', 'relative'],
    note: 'Depends on conversational history the agent does not have.',
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set. This script calls the real API — set it in .env first.',
    );
    process.exit(2);
  }

  const filter = process.argv[2];
  const fixtures = filter
    ? FIXTURES.filter(
        (f) =>
          f.tags?.includes(filter) || (filter === 'ambiguous' && f.ambiguous),
      )
    : FIXTURES;

  const classifier = new AnthropicCalendarIntentClassifier({
    get: (key: string) => process.env[key],
  } as unknown as ConfigService<never, true>);

  console.log(
    `\nEvaluating ${fixtures.length} fixtures against ${process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5'}`,
  );
  console.log(`Anchored at ${NOW.toISOString()} (${TIMEZONE})\n`);

  let clearFailures = 0;

  for (const fixture of fixtures) {
    const prefiltered = looksCalendarRelated(fixture.text);
    const intent = await classifier.classify({
      text: fixture.text,
      timeZone: TIMEZONE,
      now: NOW,
    });

    const matched = intent.intent === fixture.expect;
    const mark = matched ? '✓' : fixture.ambiguous ? '≈' : '✗';

    if (!matched && !fixture.ambiguous) clearFailures++;

    console.log(`${mark} ${JSON.stringify(fixture.text)}`);
    console.log(
      `    expected ${fixture.expect} → got ${intent.intent} (confidence ${intent.confidence})`,
    );

    // The pre-filter runs before the model in production. A calendar request it
    // drops never reaches the classifier at all, however well the model does.
    if (!prefiltered && fixture.expect !== 'not_calendar_related') {
      console.log('    ⚠  PRE-FILTER WOULD DROP THIS BEFORE THE MODEL SAW IT');
    }

    if (intent.intent === 'create_event') {
      console.log(
        `    title=${JSON.stringify(intent.title)} start=${intent.startTime} end=${intent.endTime}`,
      );
    } else if (intent.intent === 'reschedule_event') {
      console.log(
        `    query=${JSON.stringify(intent.eventQuery.titleContains)} newStart=${intent.newStartTime}`,
      );
    } else if (intent.intent === 'delete_event') {
      console.log(
        `    query=${JSON.stringify(intent.eventQuery.titleContains)}`,
      );
    } else if (intent.intent === 'needs_clarification') {
      console.log(`    asks: ${JSON.stringify(intent.question)}`);
    }

    if (fixture.note) console.log(`    note: ${fixture.note}`);
    console.log();
  }

  console.log(
    clearFailures === 0
      ? 'All CLEAR fixtures classified as expected.'
      : `${clearFailures} CLEAR fixture(s) misclassified — investigate before shipping.`,
  );
  console.log(
    'Ambiguous fixtures (≈) are for reading, not passing. Check the model asked ' +
      'rather than guessed, and that any resolved date is genuinely correct.\n',
  );

  process.exit(clearFailures === 0 ? 0 : 1);
}

void main();
