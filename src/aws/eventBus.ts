import { PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { requireEnv } from '../shared/config';
import { getEventBridgeClient } from './clients';
import type { PublicEvent } from './eventStore';

/** Subscribers match on source + detail-type, e.g. { "source": ["washops"], "detail-type": ["EQUIPMENT_FAULT"] }. */
export const EVENT_SOURCE = 'washops';

/** PutEvents accepts at most 10 entries per call. */
export const MAX_ENTRIES_PER_CALL = 10;

export function toBusEntry(event: PublicEvent): PutEventsRequestEntry {
  return {
    EventBusName: requireEnv('EVENT_BUS_NAME'),
    Source: EVENT_SOURCE,
    DetailType: event.eventType,
    Time: new Date(event.occurredAt),
    // eventId is included so subscribers can dedupe: EventBridge delivers at least once.
    Detail: JSON.stringify(event),
  };
}

/**
 * Publishes up to 10 events. PutEvents can partially fail without throwing, so this returns the
 * indexes of the entries EventBridge rejected; the caller decides what to retry.
 */
export async function publishEvents(events: PublicEvent[]): Promise<number[]> {
  const result = await getEventBridgeClient().send(new PutEventsCommand({ Entries: events.map(toBusEntry) }));
  if (!result.FailedEntryCount) return [];

  return (result.Entries ?? []).flatMap((entry, index) => (entry.ErrorCode ? [index] : []));
}
