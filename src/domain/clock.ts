/**
 * Controller clock checks. An event's timestamp comes from the controller's clock, which can be
 * wrong (dead clock battery, never synced, a time zone bug); receivedAt is server time.
 *
 * - Heartbeats are sent live, never buffered, so the gap between a heartbeat's timestamp and its
 *   receipt measures the controller's clock error directly.
 * - Other events can legitimately be old (a site uploading its backlog after an outage), so only
 *   timestamps in the future, or older than any plausible backlog, are flagged.
 *
 * Flagged events are still accepted: rejecting them would lose real washes and payments over a
 * clock setting. They are stored with clockSkewSeconds and sorted by receipt time instead.
 */

import type { WashEvent } from './events';

/** More than this far from server time means the clock is wrong, not network delay. */
export const CLOCK_TOLERANCE_SECONDS = 5 * 60;

/** Older than this at receipt is no longer a believable backlog. */
export const MAX_BACKLOG_SECONDS = 7 * 24 * 60 * 60;

/** Positive: the controller's clock is ahead of server time. */
export function clockSkewSeconds(timestamp: string, receivedAt: string): number {
  return Math.round((Date.parse(timestamp) - Date.parse(receivedAt)) / 1000);
}

export function isClockSuspect(event: Pick<WashEvent, 'eventType' | 'timestamp'>, receivedAt: string): boolean {
  const skew = clockSkewSeconds(event.timestamp, receivedAt);
  if (event.eventType === 'CONTROLLER_HEARTBEAT') return Math.abs(skew) > CLOCK_TOLERANCE_SECONDS;
  return skew > CLOCK_TOLERANCE_SECONDS || skew < -MAX_BACKLOG_SECONDS;
}

/** "3 h ahead of", "12 days behind": for warnings people read. */
export function describeSkew(skewSeconds: number): string {
  const seconds = Math.abs(skewSeconds);
  const direction = skewSeconds > 0 ? 'ahead of' : 'behind';
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ${direction}`;
  if (seconds < 2 * 86_400) return `${Math.round(seconds / 3_600)} h ${direction}`;
  return `${Math.round(seconds / 86_400)} days ${direction}`;
}
