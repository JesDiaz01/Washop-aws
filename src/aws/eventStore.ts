import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { clockSkewSeconds, isClockSuspect } from '../domain/clock';
import type { Connectivity, ReportingSite, SiteHeartbeat } from '../domain/connectivity';
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
  /** Present only when the controller's clock looks wrong: timestamp minus receivedAt. */
  clockSkewSeconds?: number;
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
  /** Server time the latest heartbeat was received, so liveness never depends on the controller's clock. */
  lastHeartbeat?: string;
  /** The controller's clock error at that heartbeat; positive means its clock is ahead. */
  controllerClockSkewSeconds?: number;
  lastUpdated?: string;
  /** Maintained by the site monitor; absent until a site is first marked offline. */
  connectivity?: Connectivity;
  connectivityChangedAt?: string;
}

export type PublicEvent = Omit<EventItem, 'expiresAt' | 'activityAt'>;

/** What API consumers and event bus subscribers see: storage internals (TTL, index key) removed. */
export function toPublicEvent(item: EventItem): PublicEvent {
  const { expiresAt, activityAt, ...publicFields } = item;
  return publicFields;
}

const eventsTable = () => requireEnv('EVENTS_TABLE');
const summaryTable = () => requireEnv('SUMMARY_TABLE');

export function toEventItem(envelope: QueueEnvelope, now: Date): EventItem {
  const { event } = envelope;
  const isHeartbeat = event.eventType === 'CONTROLLER_HEARTBEAT';
  const ttlDays = isHeartbeat ? HEARTBEAT_TTL_DAYS : EVENT_TTL_DAYS;
  const clockSuspect = isClockSuspect(event, envelope.receivedAt);

  return {
    eventId: event.eventId,
    locationId: event.locationId,
    eventType: event.eventType,
    occurredAt: event.timestamp, // what the controller reported, kept even when its clock is wrong
    // A wrong clock mustn't pin an event to the top (or bottom) of "recent activity": sort by receipt instead.
    ...(isHeartbeat ? {} : { activityAt: clockSuspect ? envelope.receivedAt : event.timestamp }),
    receivedAt: envelope.receivedAt,
    processedAt: now.toISOString(),
    correlationId: envelope.correlationId,
    archiveKey: envelope.archiveKey,
    data: event.data,
    ...(clockSuspect ? { clockSkewSeconds: clockSkewSeconds(event.timestamp, envelope.receivedAt) } : {}),
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
 *
 * T is the server's receipt time, not the controller's timestamp: a controller with a wrong clock
 * must not look offline (clock behind) or stay "online" after it goes silent (clock ahead). The
 * gap between the two is stored as the controller's clock error.
 */
async function recordHeartbeat(item: EventItem, now: Date): Promise<RecordOutcome> {
  const client = getDynamoClient();

  await client.send(new PutCommand({ TableName: eventsTable(), Item: item }));

  try {
    await client.send(
      new UpdateCommand({
        TableName: summaryTable(),
        Key: { locationId: item.locationId },
        UpdateExpression: 'SET lastHeartbeat = :ts, controllerClockSkewSeconds = :skew, lastUpdated = :now',
        ConditionExpression: 'attribute_not_exists(lastHeartbeat) OR lastHeartbeat < :ts',
        ExpressionAttributeValues: {
          ':ts': item.receivedAt,
          ':skew': clockSkewSeconds(item.occurredAt, item.receivedAt),
          ':now': now.toISOString(),
        },
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

/**
 * Every location summary. A Scan is acceptable for this table: it holds one small item per site,
 * so even hundreds of sites fit in a single 1 MB page. Pagination keeps it correct beyond that.
 */
async function scanSummaries<T>(projection?: { expression: string; names: Record<string, string> }): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await getDynamoClient().send(
      new ScanCommand({
        TableName: summaryTable(),
        ProjectionExpression: projection?.expression,
        ExpressionAttributeNames: projection?.names,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((page.Items ?? []) as T[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function listLocationSummaries(): Promise<LocationSummaryItem[]> {
  return scanSummaries<LocationSummaryItem>();
}

/** Only the attributes the site monitor needs, which keeps the Scan's read cost down. */
export function listSiteHeartbeats(): Promise<SiteHeartbeat[]> {
  return scanSummaries<SiteHeartbeat>({
    expression: '#locationId, #lastHeartbeat, #connectivity',
    names: { '#locationId': 'locationId', '#lastHeartbeat': 'lastHeartbeat', '#connectivity': 'connectivity' },
  });
}

const otherState = (state: Connectivity): Connectivity => (state === 'OFFLINE' ? 'ONLINE' : 'OFFLINE');

/**
 * Records that a site went offline or came back. Returns false, changing nothing, if that already
 * happened or a newer heartbeat arrived after the site was read. Overlapping or retried monitor
 * runs therefore never alert twice, and a heartbeat racing the check always wins.
 */
export async function recordConnectivityChange(site: ReportingSite, to: Connectivity, now: Date): Promise<boolean> {
  // A site with no connectivity attribute has never been marked offline, so it counts as ONLINE.
  const fromCondition =
    to === 'OFFLINE' ? '(attribute_not_exists(#connectivity) OR #connectivity = :from)' : '#connectivity = :from';

  try {
    await getDynamoClient().send(
      new UpdateCommand({
        TableName: summaryTable(),
        Key: { locationId: site.locationId },
        UpdateExpression: 'SET #connectivity = :to, connectivityChangedAt = :now',
        ConditionExpression: `lastHeartbeat = :seen AND ${fromCondition}`,
        ExpressionAttributeNames: { '#connectivity': 'connectivity' },
        ExpressionAttributeValues: {
          ':to': to,
          ':from': otherState(to),
          ':seen': site.lastHeartbeat,
          ':now': now.toISOString(),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/** Undoes a recorded change whose alert could not be sent, so the next monitor run tries again. */
export async function revertConnectivityChange(locationId: string, to: Connectivity): Promise<void> {
  await getDynamoClient().send(
    new UpdateCommand({
      TableName: summaryTable(),
      Key: { locationId },
      UpdateExpression: 'SET #connectivity = :from',
      ConditionExpression: '#connectivity = :to',
      ExpressionAttributeNames: { '#connectivity': 'connectivity' },
      ExpressionAttributeValues: { ':to': to, ':from': otherState(to) },
    }),
  );
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
