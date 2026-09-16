import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { QueueEnvelope, WashEvent } from '../domain/events';
import { counterIncrementsFor } from '../domain/summary';
import { requireEnv } from '../shared/config';
import { getDynamoClient } from './clients';

/**
 * DynamoDB access for WashOps.
 *
 * EventsTable           PK: eventId      -> one item per processed event (also the idempotency record)
 *   GSI LocationActivityIndex  PK: locationId, SK: activityAt -> "recent activity for a location"
 * LocationSummaryTable  PK: locationId   -> pre-aggregated counters (materialized view)
 */

export const LOCATION_ACTIVITY_INDEX = 'LocationActivityIndex';

const DAY_SECONDS = 24 * 60 * 60;
const EVENT_TTL_DAYS = 90;
const HEARTBEAT_TTL_DAYS = 7;

export type RecordOutcome = 'PROCESSED' | 'DUPLICATE' | 'STALE_HEARTBEAT';

export interface EventItem {
  eventId: string;
  locationId: string;
  eventType: WashEvent['eventType'];
  occurredAt: string;
  /** GSI sort key. Omitted for heartbeats so they stay out of the activity index (a "sparse" index). */
  activityAt?: string;
  receivedAt: string;
  processedAt: string;
  correlationId: string;
  archiveKey: string;
  data: WashEvent['data'];
  /** Epoch seconds. DynamoDB TTL deletes the item after this time at no cost. */
  expiresAt: number;
}

export interface LocationSummaryItem {
  locationId: string;
  washesStarted?: number;
  completedWashes?: number;
  washRevenueCents?: number;
  paymentsCompleted?: number;
  paymentVolumeCents?: number;
  equipmentFaults?: number;
  lastHeartbeat?: string;
  lastUpdated?: string;
}

const eventsTable = () => requireEnv('EVENTS_TABLE');
const summaryTable = () => requireEnv('SUMMARY_TABLE');

export function toEventItem(envelope: QueueEnvelope, now: Date): EventItem {
  const { event } = envelope;
  const isHeartbeat = event.eventType === 'CONTROLLER_HEARTBEAT';
  const ttlDays = isHeartbeat ? HEARTBEAT_TTL_DAYS : EVENT_TTL_DAYS;

  return {
    eventId: event.eventId,
    locationId: event.locationId,
    eventType: event.eventType,
    occurredAt: event.timestamp,
    ...(isHeartbeat ? {} : { activityAt: event.timestamp }),
    receivedAt: envelope.receivedAt,
    processedAt: now.toISOString(),
    correlationId: envelope.correlationId,
    archiveKey: envelope.archiveKey,
    data: event.data,
    expiresAt: Math.floor(now.getTime() / 1000) + ttlDays * DAY_SECONDS,
  };
}

/**
 * Records an event exactly once, even if SQS delivers it multiple times.
 */
export async function recordEvent(envelope: QueueEnvelope, now = new Date()): Promise<RecordOutcome> {
  const item = toEventItem(envelope, now);

  if (envelope.event.eventType === 'CONTROLLER_HEARTBEAT') {
    return recordHeartbeat(item, now);
  }

  const increments = Object.entries(counterIncrementsFor(envelope.event));
  const names: Record<string, string> = { '#lastUpdated': 'lastUpdated' };
  const values: Record<string, unknown> = { ':now': now.toISOString() };
  const addClauses = increments.map(([counter, amount], i) => {
    names[`#c${i}`] = counter;
    values[`:c${i}`] = amount;
    return `#c${i} :c${i}`;
  });

  try {
    // Both writes commit together or not at all.
    await getDynamoClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            // 1) Idempotency: fails if this eventId was already processed.
            Put: {
              TableName: eventsTable(),
              Item: item,
              ConditionExpression: 'attribute_not_exists(eventId)',
            },
          },
          {
            // 2) Side effect: ADD is atomic and creates the summary item/counters if missing.
            Update: {
              TableName: summaryTable(),
              Key: { locationId: item.locationId },
              UpdateExpression: `ADD ${addClauses.join(', ')} SET #lastUpdated = :now`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
        ],
      }),
    );
    return 'PROCESSED';
  } catch (error) {
    // CancellationReasons is ordered like TransactItems; index 0 is the idempotency Put.
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return 'DUPLICATE';
    }
    throw error; // throttling, service errors -> message is retried by SQS
  }
}

/**
 * Heartbeats don't need a dedupe transaction: "move lastHeartbeat forward to T" gives the same
 * result no matter how many times it runs (naturally idempotent). The condition also protects
 * against out-of-order delivery, since standard SQS doesn't guarantee ordering.
 */
async function recordHeartbeat(item: EventItem, now: Date): Promise<RecordOutcome> {
  const client = getDynamoClient();

  await client.send(new PutCommand({ TableName: eventsTable(), Item: item }));

  try {
    await client.send(
      new UpdateCommand({
        TableName: summaryTable(),
        Key: { locationId: item.locationId },
        UpdateExpression: 'SET lastHeartbeat = :ts, lastUpdated = :now',
        ConditionExpression: 'attribute_not_exists(lastHeartbeat) OR lastHeartbeat < :ts',
        ExpressionAttributeValues: { ':ts': item.occurredAt, ':now': now.toISOString() },
      }),
    );
    return 'PROCESSED';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return 'STALE_HEARTBEAT'; // an equal or newer heartbeat was already recorded
    }
    throw error;
  }
}

export async function getEvent(eventId: string): Promise<EventItem | undefined> {
  const result = await getDynamoClient().send(new GetCommand({ TableName: eventsTable(), Key: { eventId } }));
  return result.Item as EventItem | undefined;
}

export async function getLocationSummary(locationId: string): Promise<LocationSummaryItem | undefined> {
  const result = await getDynamoClient().send(new GetCommand({ TableName: summaryTable(), Key: { locationId } }));
  return result.Item as LocationSummaryItem | undefined;
}

/** Most recent non-heartbeat events for a location, newest first (Query on the GSI, never a Scan). */
export async function listRecentEvents(locationId: string, limit: number): Promise<EventItem[]> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: eventsTable(),
      IndexName: LOCATION_ACTIVITY_INDEX,
      KeyConditionExpression: 'locationId = :locationId',
      ExpressionAttributeValues: { ':locationId': locationId },
      ScanIndexForward: false, // sort key descending = newest first
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as EventItem[];
}
