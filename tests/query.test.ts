import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/query';
import { httpEvent, lambdaContext, TEST_CLIENT_ID, TEST_SCOPES } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);

interface Caller {
  clientId: string;
  scopes: string[];
}

/** The demo site's controller credential (bound to miami-01). */
const siteController: Caller = { clientId: TEST_CLIENT_ID, scopes: TEST_SCOPES };
/** A person signed in to the dashboard (DASHBOARD_CLIENT_ID in vitest.config.mts). */
const dashboardUser: Caller = { clientId: 'test-dashboard-client', scopes: ['openid', 'email', 'washops/events.read'] };

function get(
  routeKey: string,
  pathParameters: Record<string, string>,
  { query, caller = siteController }: { query?: Record<string, string>; caller?: Caller } = {},
) {
  const event = httpEvent({ routeKey, pathParameters, queryStringParameters: query });
  event.requestContext.authorizer.jwt = {
    claims: { client_id: caller.clientId, scope: caller.scopes.join(' ') },
    scopes: caller.scopes,
  };
  return handler(event, lambdaContext);
}

const locationIds = (body: string | undefined) =>
  (JSON.parse(body!) as { locations: { locationId: string }[] }).locations.map((l) => l.locationId);

describe('query handler', () => {
  beforeEach(() => ddbMock.reset());

  it('returns a location summary with cents converted to dollars', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { locationId: 'miami-01', completedWashes: 42, washRevenueCents: 83050, equipmentFaults: 2 },
    });

    const response = await get('GET /locations/{locationId}/summary', { locationId: 'miami-01' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toMatchObject({
      locationId: 'miami-01',
      completedWashes: 42,
      totalRevenue: 830.5,
      equipmentFaults: 2,
      lastHeartbeat: null,
      connectivity: 'UNKNOWN',
    });
  });

  it('lists every location sorted by ID for a dashboard user, with connectivity from the site monitor', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { locationId: 'tampa-02', lastHeartbeat: '2026-09-14T18:00:00.000Z', connectivity: 'OFFLINE' },
        { locationId: 'miami-01', lastHeartbeat: '2026-09-14T18:31:00.000Z' },
      ],
    });

    const response = await get('GET /locations', {}, { caller: dashboardUser });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body!);
    expect(body.count).toBe(2);
    expect(body.locations.map((l: { locationId: string; connectivity: string }) => [l.locationId, l.connectivity])).toEqual([
      ['miami-01', 'ONLINE'],
      ['tampa-02', 'OFFLINE'],
    ]);
  });

  it('returns 404 when an event has not been processed (yet)', async () => {
    ddbMock.on(GetCommand).resolves({});

    const response = await get('GET /events/{eventId}', { eventId: 'evt-missing' });

    expect(response.statusCode).toBe(404);
  });

  it('queries the location activity index newest-first and validates limit', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const ok = await get('GET /locations/{locationId}/events', { locationId: 'miami-01' }, { query: { limit: '5' } });
    const bad = await get('GET /locations/{locationId}/events', { locationId: 'miami-01' }, { query: { limit: '5000' } });

    expect(ok.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'LocationActivityIndex',
      ScanIndexForward: false,
      Limit: 5,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('query handler: site credentials read only their own site', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(ScanCommand).resolves({ Items: [{ locationId: 'miami-01' }, { locationId: 'tampa-02' }] });
  });

  it("lists only the credential's own site", async () => {
    const response = await get('GET /locations', {});

    expect(response.statusCode).toBe(200);
    expect(locationIds(response.body)).toEqual(['miami-01']);
  });

  it("refuses another site's summary and activity without reading DynamoDB", async () => {
    const summary = await get('GET /locations/{locationId}/summary', { locationId: 'tampa-02' });
    const activity = await get('GET /locations/{locationId}/events', { locationId: 'tampa-02' });

    expect(summary.statusCode).toBe(403);
    expect(activity.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("answers for another site's event exactly as for a missing one", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { eventId: 'evt-tampa', locationId: 'tampa-02', eventType: 'WASH_STARTED' } });

    const response = await get('GET /events/{eventId}', { eventId: 'evt-tampa' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('tampa-02');
  });

  it('gains nothing by requesting a token without its site scope', async () => {
    // Client credentials may ask for a subset of the client's scopes; dropping the site scope narrows access.
    const unscoped: Caller = { clientId: TEST_CLIENT_ID, scopes: ['washops/events.read'] };

    const list = await get('GET /locations', {}, { caller: unscoped });
    const summary = await get('GET /locations/{locationId}/summary', { locationId: 'tampa-02' }, { caller: unscoped });

    expect(locationIds(list.body)).toEqual([]);
    expect(summary.statusCode).toBe(403);
  });
});
