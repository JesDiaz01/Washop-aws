import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/query';
import { httpEvent, lambdaContext } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);

const get = (routeKey: string, pathParameters: Record<string, string>, queryStringParameters?: Record<string, string>) =>
  handler(httpEvent({ routeKey, pathParameters, queryStringParameters }), lambdaContext);

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
    });
  });

  it('returns 404 when an event has not been processed (yet)', async () => {
    ddbMock.on(GetCommand).resolves({});

    const response = await get('GET /events/{eventId}', { eventId: 'evt-missing' });

    expect(response.statusCode).toBe(404);
  });

  it('queries the location activity index newest-first and validates limit', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const ok = await get('GET /locations/{locationId}/events', { locationId: 'miami-01' }, { limit: '5' });
    const bad = await get('GET /locations/{locationId}/events', { locationId: 'miami-01' }, { limit: '5000' });

    expect(ok.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      IndexName: 'LocationActivityIndex',
      ScanIndexForward: false,
      Limit: 5,
    });
    expect(bad.statusCode).toBe(400);
  });
});
