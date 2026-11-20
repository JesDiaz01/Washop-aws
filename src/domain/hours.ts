/**
 * Trends are counted per site per UTC hour. Hours rather than days because a site's business day
 * depends on its time zone: the dashboard adds hours up into days in the viewer's zone, so a Miami
 * site's day doesn't end at 7 pm local time.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The hour bucket of an ISO timestamp in UTC (a "Z" timestamp, as stored), e.g. 2026-11-20T14. */
export function hourOf(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().slice(0, 13);
}

/** The start of a bucket as a full ISO timestamp, e.g. 2026-11-20T14:00:00.000Z. */
export function hourStart(hour: string): string {
  return `${hour}:00:00.000Z`;
}

/** The first bucket of a window of `hours` hours that ends with the current one. */
export function firstHourOfWindow(now: Date, hours: number): string {
  return hourOf(new Date(now.getTime() - (hours - 1) * HOUR_MS).toISOString());
}
