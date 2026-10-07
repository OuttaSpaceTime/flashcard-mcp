/**
 * The study day: a calendar day in the developer's own time zone, never UTC.
 * Bucketing a UTC+2 developer's evening by UTC date moves everything after
 * 22:00 into the next day, so the streak, the overview's week and true
 * retention's one-review-per-card-per-day rule would each disagree about which
 * day a review belongs to. Every day key in this package comes from here.
 */

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD of `d` in `timeZone` (the system's by default). */
export function localDay(d: Date, timeZone: string = systemTimeZone()): string {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    // en-CA renders as YYYY-MM-DD, so the formatted day is its own key.
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f.format(d);
}
