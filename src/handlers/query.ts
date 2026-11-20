import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import type {
  LocationListResponse,
  LocationSummaryResponse,
  RecentEventsResponse,
  TrendResponse,
} from '../api/responses';
import {
  getEvent,
  getLocationSummary,
  type HourlyStatsItem,
  listHourlyStats,
  listLocationSummaries,
  listRecentEvents,
  type LocationSummaryItem,
  toPublicEvent,
} from '../aws/eventStore';
import { reportedConnectivity } from '../domain/connectivity';
import { eventIdSchema, locationIdSchema } from '../domain/events';
import { firstHourOfWindow, hourStart } from '../domain/hours';
import { boundSites } from '../domain/siteAccess';
import { requireEnv } from '../shared/config';
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from '../shared/errors';
import { callerClientId, callerScopes, jsonResponse } from '../shared/http';
import { createLogger, serializeError } from '../shared/logger';

/**
 * Read API. One function serves all GET routes; API Gateway passes the matched route in routeKey.
 *
 *   GET /locations
 *   GET /locations/{locationId}/summary
 *   GET /locations/{locationId}/events?limit=20
 *   GET /locations/{locationId}/trend?hours=168
 *   GET /events/{eventId}
 */

const logger = createLogger({ service: 'washops-query' });

const LIMIT = { name: 'limit', fallback: 20, max: 50 };
const TREND_HOURS = { name: 'hours', fallback: 168, max: 720 }; // 7 days by default, up to 30

function pathParam(event: APIGatewayProxyEventV2WithJWTAuthorizer, name: string, schema: typeof eventIdSchema): string {
  const result = schema.safeParse(event.pathParameters?.[name]);
  if (!result.success) {
    throw new BadRequestError(`Invalid ${name}`);
  }
  return result.data;
}

function parseCount(raw: string | undefined, { name, fallback, max }: typeof LIMIT): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * Which sites the caller may read. People signed in to the dashboard see every site; any other
 * credential (a site controller's) sees only the sites its washops/site.* scopes name, so one site
 * can't read another's revenue. The app client decides, not the scopes: a site client can request a
 * token without its site scope, and that must narrow its access, never widen it.
 */
type ReadableSites = 'ALL' | ReadonlySet<string>;

function readableSites(event: APIGatewayProxyEventV2WithJWTAuthorizer): ReadableSites {
  if (callerClientId(event) === requireEnv('DASHBOARD_CLIENT_ID')) return 'ALL';
  return new Set(boundSites(callerScopes(event)));
}

const canRead = (sites: ReadableSites, locationId: string) => sites === 'ALL' || sites.has(locationId);

function requireReadable(sites: ReadableSites, locationId: string): void {
  if (!canRead(sites, locationId)) throw new ForbiddenError(`This credential may not read location ${locationId}`);
}

const centsToDollars = (cents: number | undefined) => (cents ?? 0) / 100;

export function toSummaryResponse(item: LocationSummaryItem): LocationSummaryResponse {
  return {
    locationId: item.locationId,
    washesStarted: item.washesStarted ?? 0,
    completedWashes: item.completedWashes ?? 0,
    totalRevenue: centsToDollars(item.washRevenueCents),
    paymentsCompleted: item.paymentsCompleted ?? 0,
    paymentVolume: centsToDollars(item.paymentVolumeCents),
    equipmentFaults: item.equipmentFaults ?? 0,
    lastHeartbeat: item.lastHeartbeat ?? null,
    // From the latest heartbeat: how far the controller's clock is off (positive = ahead).
    controllerClockSkewSeconds: item.controllerClockSkewSeconds ?? null,
    // The site monitor's verdict, or ONLINE as soon as a heartbeat follows an OFFLINE mark.
    // UNKNOWN: no heartbeat ever received.
    connectivity: reportedConnectivity(item),
    connectivityChangedAt: item.connectivityChangedAt ?? null,
    lastUpdated: item.lastUpdated ?? null,
  };
}

const toHourlyResponse = (item: HourlyStatsItem): TrendResponse['hours'][number] => ({
  hour: hourStart(item.hour),
  washesStarted: item.washesStarted ?? 0,
  completedWashes: item.completedWashes ?? 0,
  revenue: centsToDollars(item.washRevenueCents),
  paymentsCompleted: item.paymentsCompleted ?? 0,
  paymentVolume: centsToDollars(item.paymentVolumeCents),
  equipmentFaults: item.equipmentFaults ?? 0,
});

async function route(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const sites = readableSites(event);

  switch (event.routeKey) {
    case 'GET /locations': {
      const locations = (await listLocationSummaries())
        .filter((summary) => canRead(sites, summary.locationId))
        .map(toSummaryResponse)
        .sort((a, b) => a.locationId.localeCompare(b.locationId));
      return jsonResponse(200, { count: locations.length, locations } satisfies LocationListResponse);
    }

    case 'GET /locations/{locationId}/summary': {
      const locationId = pathParam(event, 'locationId', locationIdSchema);
      requireReadable(sites, locationId);
      const summary = await getLocationSummary(locationId);
      if (!summary) throw new NotFoundError(`No summary found for location ${locationId}`);
      return jsonResponse(200, toSummaryResponse(summary));
    }

    case 'GET /locations/{locationId}/events': {
      const locationId = pathParam(event, 'locationId', locationIdSchema);
      requireReadable(sites, locationId);
      const limit = parseCount(event.queryStringParameters?.limit, LIMIT);
      const items = await listRecentEvents(locationId, limit);
      return jsonResponse(200, {
        locationId,
        count: items.length,
        events: items.map(toPublicEvent),
      } satisfies RecentEventsResponse);
    }

    case 'GET /locations/{locationId}/trend': {
      const locationId = pathParam(event, 'locationId', locationIdSchema);
      requireReadable(sites, locationId);
      const hours = parseCount(event.queryStringParameters?.hours, TREND_HOURS);
      const fromHour = firstHourOfWindow(new Date(), hours);
      const items = await listHourlyStats(locationId, fromHour);
      return jsonResponse(200, {
        locationId,
        from: hourStart(fromHour),
        hours: items.map(toHourlyResponse),
      } satisfies TrendResponse);
    }

    case 'GET /events/{eventId}': {
      const eventId = pathParam(event, 'eventId', eventIdSchema);
      const item = await getEvent(eventId);
      // 404 can also mean "accepted but still in the queue": processing is asynchronous. Another
      // site's event gets the same answer, so a site credential can't probe which IDs exist.
      if (!item || !canRead(sites, item.locationId)) {
        throw new NotFoundError(`Event ${eventId} not found (it may not be processed yet)`);
      }
      return jsonResponse(200, toPublicEvent(item));
    }

    default:
      throw new NotFoundError(`Route not found: ${event.routeKey}`);
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const log = logger.child({
    awsRequestId: context.awsRequestId,
    apiRequestId: event.requestContext.requestId,
    routeKey: event.routeKey,
    clientId: callerClientId(event),
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
