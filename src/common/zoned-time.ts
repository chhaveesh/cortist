/**
 * Wall-clock time in a specific IANA zone.
 *
 * Exists because the alternative — handing a model a UTC timestamp plus a
 * timezone name and trusting it to convert — is arithmetic, and models are
 * unreliable at arithmetic in a way that is invisible until it matters. It
 * mattered on 2026-07-23: the router sent `2026-07-22T20:43Z` with
 * "User timezone: Asia/Kolkata", and `gemini-flash-lite` read the UTC date as
 * the local one. At 02:13 IST that put "today" a day in the past, so
 * "add a dentist appointment today at 10am" landed on the wrong date. A
 * stronger model happened to get it right, which is worse than it sounds: the
 * bug was latent and surfaced only on changing model.
 *
 * These helpers do the conversion exactly, so the model is given the answer
 * rather than asked for it.
 */

export interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
}

/** The wall-clock components of `date` as seen in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(date);

  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Intl renders midnight as "24" in some zones.
    hour: read('hour') === '24' ? '00' : read('hour'),
    minute: read('minute'),
    second: read('second'),
    weekday: parts.find((part) => part.type === 'weekday')?.value ?? '',
  };
}

/** The UTC offset in force in `timeZone` at `date`, as "+05:30". */
export function zonedOffset(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;

  // "GMT+05:30" → "+05:30"; a bare "GMT" means UTC.
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name ?? '');
  return match ? match[1] : '+00:00';
}

/**
 * `now` as the user would read it on their own clock, for the model's prompt.
 *
 * Example: `2026-07-23T02:13:16+05:30 (Thursday)`.
 *
 * The weekday is included because it is another thing the model would otherwise
 * have to derive — "next Tuesday" is a common phrasing, and getting there from
 * a bare date is exactly the kind of step that silently goes wrong.
 */
export function formatZonedNow(now: Date, timeZone: string): string {
  try {
    const p = zonedParts(now, timeZone);
    const offset = zonedOffset(now, timeZone);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset} (${p.weekday})`;
  } catch {
    // An unrecognised zone must not break classification outright; UTC is a
    // worse answer than the user's zone but a usable one.
    return now.toISOString();
  }
}
