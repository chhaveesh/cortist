/**
 * Manual router evaluation against the REAL Anthropic API.
 *
 * Deliberately outside CI, for the same reasons as eval-intent.ts: it costs
 * money, needs a key, and its ambiguous cases are judgement calls. The
 * automated suite scripts the classifier, which by construction says nothing
 * about whether the model routes real phrasings correctly — or whether it is
 * honest about its own uncertainty, which is what the whole clarification
 * mechanism depends on.
 *
 *   npm run eval:router
 *   npm run eval:router -- ambiguous
 *
 * Prints the model's own `reason` for every fixture, so the reasoning can be
 * read rather than just the label. A right answer for a wrong reason is worth
 * knowing about before it becomes a wrong answer.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AnthropicRouteClassifier } from '../src/router/intent/route-classifier.service';
import { RouteName } from '../src/router/intent/route-intent.schema';
import { looksActionable } from '../src/router/intent/router-keyword-filter';

config({ path: resolve(__dirname, '..', '.env') });

interface Fixture {
  text: string;
  expect: RouteName | 'ambiguous';
  ambiguous?: boolean;
  note?: string;
}

const TIMEZONE = 'Europe/London';
const NOW = new Date('2026-07-20T09:00:00+01:00'); // a Monday

const FIXTURES: Fixture[] = [
  // --- clear-cut, one per category ---------------------------------------
  { text: 'book a dentist appointment tomorrow at 3pm', expect: 'calendar' },
  { text: 'cancel my dentist appointment on Friday', expect: 'calendar' },
  { text: 'move my 2pm call to 4pm', expect: 'calendar' },
  {
    text: 'save this: the API rate limit is 1000 requests per minute',
    expect: 'rag_ingest',
  },
  { text: 'remember that the wifi password is hunter2', expect: 'rag_ingest' },
  { text: 'save this https://example.com/an-article', expect: 'rag_ingest' },
  { text: 'what did the Q3 report say about revenue?', expect: 'rag_query' },
  { text: 'what do I know about the Acme contract?', expect: 'rag_query' },
  { text: 'hey, how are you?', expect: 'unrelated' },
  {
    text: 'what is the capital of France?',
    expect: 'unrelated',
    note: 'General knowledge, NOT a question about saved material.',
  },
  { text: 'tell me a joke', expect: 'unrelated' },

  // --- the inverse: mentions both domains, but states its intent ----------
  {
    text: 'create a calendar event to review the Q3 report tomorrow at 3pm',
    expect: 'calendar',
    note: 'MUST NOT ask. Mentions a document, but the action is unambiguous.',
  },
  {
    text: 'save this: my dentist appointment is on the 14th',
    expect: 'rag_ingest',
    note: 'MUST NOT ask. Mentions an appointment, but "save this" is explicit.',
  },

  // --- genuinely ambiguous -----------------------------------------------
  {
    text: 'remind me about the Q3 report',
    expect: 'ambiguous',
    ambiguous: true,
    note: 'A reminder to set, or a document to look up.',
  },
  {
    text: "what's happening with the client thing",
    expect: 'ambiguous',
    ambiguous: true,
    note: 'Upcoming meetings, or notes about the client.',
  },
  {
    text: "note about tomorrow's meeting",
    expect: 'ambiguous',
    ambiguous: true,
    note: 'Create the meeting, or save a note about it.',
  },
  {
    text: 'keep this in mind for next week',
    expect: 'ambiguous',
    ambiguous: true,
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set. This script calls the real API — set it in .env first.',
    );
    process.exit(2);
  }

  const only = process.argv[2];
  const fixtures =
    only === 'ambiguous' ? FIXTURES.filter((f) => f.ambiguous) : FIXTURES;

  const classifier = new AnthropicRouteClassifier({
    get: (key: string) => process.env[key],
  } as unknown as ConfigService<never, true>);

  console.log(
    `\nRouting ${fixtures.length} fixtures via ${process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5'}`,
  );
  console.log(`Anchored at ${NOW.toISOString()} (${TIMEZONE})\n`);

  let clearFailures = 0;

  for (const fixture of fixtures) {
    if (!looksActionable(fixture.text) && fixture.expect !== 'unrelated') {
      // The filter runs before the router in production, so a dropped fixture
      // never reaches the model however well it would have done.
      console.log(
        `⚠  PRE-FILTER DROPS THIS: ${JSON.stringify(fixture.text)}\n`,
      );
      clearFailures++;
      continue;
    }

    const decision = await classifier.classify({
      text: fixture.text,
      timeZone: TIMEZONE,
      now: NOW,
    });

    const matched = decision.route === fixture.expect;
    const mark = matched ? '✓' : fixture.ambiguous ? '≈' : '✗';
    if (!matched && !fixture.ambiguous) clearFailures++;

    console.log(`${mark} ${JSON.stringify(fixture.text)}`);
    console.log(`    expected ${fixture.expect} → got ${decision.route}`);
    // The reasoning, not just the label.
    console.log(`    reason: ${decision.reason}`);

    if (decision.route === 'ambiguous') {
      console.log(`    would ask between: ${decision.between.join(' / ')}`);
    } else if (decision.route === 'calendar') {
      const i = decision.intent;
      console.log(
        `    calendar intent: ${i.intent}${
          i.intent === 'create_event' ? ` "${i.title}" @ ${i.startTime}` : ''
        }`,
      );
    } else if (
      decision.route === 'rag_ingest' ||
      decision.route === 'rag_query'
    ) {
      console.log(`    rag intent: ${JSON.stringify(decision.intent)}`);
    }

    if (fixture.note) console.log(`    note: ${fixture.note}`);
    console.log();
  }

  console.log(
    clearFailures === 0
      ? 'All CLEAR fixtures routed as expected.'
      : `${clearFailures} CLEAR fixture(s) misrouted — investigate before shipping.`,
  );
  console.log(
    'Ambiguous fixtures (≈) are for reading. Check the model asked rather than\n' +
      'guessed, and that the two options it names are the right two.\n',
  );

  process.exit(clearFailures === 0 ? 0 : 1);
}

void main();
