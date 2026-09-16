import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { type EventItem, getEvent, getLocationSummary, listRecentEvents, type LocationSummaryItem } from '../aws/eventStore';
import { eventIdSchema, locationIdSchema } from '../domain/events';
import { BadRequestError, HttpError, NotFoundError } from '../shared/errors';
import { jsonResponse } from '../shared/http';
import { createLogger, serializeError } from '../shared/logger';

/**
 * Read API. One function serves all GET routes; API Gateway passes the matched route in routeKey.
 *
 *   GET /locations/{locationId}/summary
 *   GET /locations/{locationId}/events?limit=20
 *   GET /events/{eventId}
 */

const logger = createLogger({ service: 'washops-query' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function pathParam(event: APIGatewayProxyEventV2, name: string, schema: typeof eventIdSchema): string {
  const result = schema.safeParse(event.pathParameters?.[name]);
  if (!result.success) {
    throw new BadRequestError(`Invalid ${name}`);
  }
  return result.data;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

const centsToDollars = (cents: number | undefined) => (cents ?? 0) / 100;

export function toSummaryResponse(item: LocationSummaryItem) {
  return {
    locationId: item.locationId,
    washesStarted: item.washesStarted ?? 0,
    completedWashes: item.completedWashes ?? 0,
    totalRevenue: centsToDollars(item.washRevenueCents),
    paymentsCompleted: item.paymentsCompleted ?? 0,
    paymentVolume: centsToDollars(item.paymentVolumeCents),
    equipmentFaults: item.equipmentFaults ?? 0,
    lastHeartbeat: item.lastHeartbeat ?? null,
    lastUpdated: item.lastUpdated ?? null,
  };
}

function toEventResponse(item: EventItem) {
  // Hide storage internals (TTL + index key) from API consumers.
  const { expiresAt, activityAt, ...publicFields } = item;
  return publicFields;
}

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.routeKey) {
    case 'GET /locations/{locationId}/summary': {
      const locationId = pathParam(event, 'locationId', locationIdSchema);
      const summary = await getLocationSummary(locationId);
      if (!summary) throw new NotFoundError(`No summary found for location ${locationId}`);
      return jsonResponse(200, toSummaryResponse(summary));
    }

    case 'GET /locations/{locationId}/events': {
      const locationId = pathParam(event, 'locationId', locationIdSchema);
      const limit = parseLimit(event.queryStringParameters?.limit);
      const items = await listRecentEvents(locationId, limit);
      return jsonResponse(200, { locationId, count: items.length, events: items.map(toEventResponse) });
    }

    case 'GET /events/{eventId}': {
      const eventId = pathParam(event, 'eventId', eventIdSchema);
      const item = await getEvent(eventId);
      // 404 can also mean "accepted but still in the queue": processing is asynchronous.
      if (!item) throw new NotFoundError(`Event ${eventId} not found (it may not be processed yet)`);
      return jsonResponse(200, toEventResponse(item));
    }

    default:
      throw new NotFoundError(`Route not found: ${event.routeKey}`);
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const log = logger.child({
    awsRequestId: context.awsRequestId,
    apiRequestId: event.requestContext.requestId,
    routeKey: event.routeKey,
  });

  try {
    const response = await route(event);
    log.info('Query served', { statusCode: response.statusCode });
    return response;
  } catch (error) {
    if (error instanceof HttpError) {
      log.info('Query rejected', { statusCode: error.statusCode, reason: error.message });
      return jsonResponse(error.statusCode, { message: error.message });
    }
    log.error('Query failed', { error: serializeError(error) });
    return jsonResponse(500, { message: 'Internal server error' });
  }
};
