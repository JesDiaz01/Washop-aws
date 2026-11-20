import { z } from 'zod';
import {
  controllerHeartbeatSchema,
  equipmentFaultSchema,
  eventIdSchema,
  locationIdSchema,
  paymentCompletedSchema,
  washCompletedSchema,
  washStartedSchema,
} from '../domain/events';
import {
  errorResponseSchema,
  eventAcceptedSchema,
  hourlyStatsSchema,
  locationListSchema,
  locationSummarySchema,
  processedEventSchema,
  recentEventsSchema,
  trendSchema,
} from './responses';

/**
 * Builds docs/openapi.json from the same zod schemas that validate requests (src/domain/events.ts)
 * and type responses (./responses.ts). tests/openapi.test.ts fails when the committed file is out of
 * date or when its routes and scopes differ from template.yaml; `npm run openapi` regenerates it.
 */

type JsonSchema = Record<string, unknown>;

/**
 * Requests are documented as accepted (`input`): unknown fields are allowed, because the API strips
 * them. Responses are documented as returned (`output`), minus `additionalProperties: false`: clients
 * should ignore fields added later, while the tests still fail on any field not documented here.
 */
const conversion = (io: 'input' | 'output') => ({
  io,
  uri: (id: string) => `#/components/schemas/${id}`, // a component used inside another becomes a $ref
  override: ({ jsonSchema: node }: { jsonSchema: JsonSchema }) => {
    if (node.format === 'date-time') delete node.pattern; // the format says what the long regex says
    if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum; // zod's int() bound, not an API limit
    if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
    if (io === 'output' && node.additionalProperties === false) delete node.additionalProperties;
  },
});

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, conversion(io));
  return rest;
}

function components(schemas: Record<string, z.ZodType>, io: 'input' | 'output'): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) registry.add(schema, { id });
  const converted = z.toJSONSchema(registry, conversion(io)).schemas;
  return Object.fromEntries(
    Object.entries(converted).map(([id, { $schema: _dialect, $id: _id, ...rest }]) => [id, rest]),
  );
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const response = (description: string, schema: object = ref('Error')) => ({ description, content: json(schema) });

const correlationHeader = {
  'x-correlation-id': {
    description: 'Echoes the request header, or the ID generated for this request; it is on every log line',
    schema: { type: 'string' },
  },
};

const common = {
  401: response('Missing, expired, or invalid access token (rejected by API Gateway before any Lambda runs)'),
  429: response('Throttled: more than 25 requests/s (burst 50) across the API'),
  500: response('Unexpected server error; details are only in the logs'),
};

const events = {
  WashStartedEvent: washStartedSchema,
  WashCompletedEvent: washCompletedSchema,
  PaymentCompletedEvent: paymentCompletedSchema,
  EquipmentFaultEvent: equipmentFaultSchema,
  ControllerHeartbeatEvent: controllerHeartbeatSchema,
};

const locationIdParam = {
  name: 'locationId',
  in: 'path',
  required: true,
  schema: jsonSchema(locationIdSchema, 'input'),
};

const read = [{ cognito: ['washops/events.read'] }];

export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'WashOps API',
      version: '1.0.0',
      description:
        'Car wash controllers send operational events; the operations dashboard reads per-site summaries ' +
        'and recent activity. Events are accepted asynchronously (202) and processed exactly once. ' +
        'A site credential may send and read only its own location (scope washops/site.<locationId>).',
    },
    servers: [
      {
        url: '{apiBaseUrl}',
        variables: { apiBaseUrl: { default: 'https://api.example.com', description: "The stack's ApiBaseUrl output" } },
      },
    ],
    paths: {
      '/events': {
        post: {
          operationId: 'sendEvent',
          summary: 'Send one controller event',
          security: [{ cognito: ['washops/events.write'] }],
          parameters: [
            { name: 'x-correlation-id', in: 'header', required: false, schema: { type: 'string', maxLength: 128 } },
          ],
          requestBody: {
            required: true,
            description: 'At most 64 KB. Unknown fields are ignored (and kept in the raw archive).',
            content: json({
              oneOf: Object.keys(events).map(ref),
              discriminator: { propertyName: 'eventType' },
            }),
          },
          responses: {
            202: { ...response('Archived and queued for processing', ref('EventAccepted')), headers: correlationHeader },
            400: response('Invalid JSON or event, with one entry per invalid field'),
            ...common,
            403: response("This credential isn't bound to the event's locationId; nothing was stored"),
            413: response('Body larger than 64 KB'),
          },
        },
      },
      '/locations': {
        get: {
          operationId: 'listLocations',
          summary: 'Summaries of every site this credential may read',
          security: read,
          responses: { 200: response('Sorted by locationId', ref('LocationList')), ...common },
        },
      },
      '/locations/{locationId}/summary': {
        get: {
          operationId: 'getLocationSummary',
          summary: "One site's counters and connectivity",
          security: read,
          parameters: [locationIdParam],
          responses: {
            200: response('The summary', ref('LocationSummary')),
            400: response('Invalid locationId'),
            ...common,
            403: response("This credential may not read the site's data"),
            404: response('No events recorded for this site yet'),
          },
        },
      },
      '/locations/{locationId}/events': {
        get: {
          operationId: 'listRecentEvents',
          summary: "A site's recent activity, newest first",
          security: read,
          parameters: [
            locationIdParam,
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
          ],
          responses: {
            200: response('Recent events', ref('RecentEvents')),
            400: response('Invalid locationId or limit'),
            ...common,
            403: response("This credential may not read the site's data"),
          },
        },
      },
      '/locations/{locationId}/trend': {
        get: {
          operationId: 'getLocationTrend',
          summary: "A site's counters per hour, for trend charts",
          description:
            'Hours are UTC, so a client can add them up into days in any time zone. Kept for 90 days.',
          security: read,
          parameters: [
            locationIdParam,
            {
              name: 'hours',
              in: 'query',
              required: false,
              description: 'How many hours, ending with the current one',
              schema: { type: 'integer', minimum: 1, maximum: 720, default: 168 },
            },
          ],
          responses: {
            200: response('Hourly counters', ref('Trend')),
            400: response('Invalid locationId or hours'),
            ...common,
            403: response("This credential may not read the site's data"),
          },
        },
      },
      '/events/{eventId}': {
        get: {
          operationId: 'getEvent',
          summary: 'One processed event',
          security: read,
          parameters: [{ name: 'eventId', in: 'path', required: true, schema: jsonSchema(eventIdSchema, 'input') }],
          responses: {
            200: response('The event as stored', ref('ProcessedEvent')),
            400: response('Invalid eventId'),
            ...common,
            404: response(
              "Not processed yet (processing is asynchronous), or another site's event: both get the same answer",
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        cognito: {
          type: 'oauth2',
          description:
            "Amazon Cognito. Site controllers use client credentials; the dashboard signs people in with the authorization code flow and PKCE. The real URLs are the stack's TokenUrl and AuthDomain outputs.",
          flows: {
            clientCredentials: {
              tokenUrl: 'https://auth.example.com/oauth2/token',
              scopes: {
                'washops/events.write': 'Send events',
                'washops/events.read': 'Read summaries and events',
                'washops/site.{locationId}': 'Binds a site credential to one location, for both sending and reading',
              },
            },
            authorizationCode: {
              authorizationUrl: 'https://auth.example.com/oauth2/authorize',
              tokenUrl: 'https://auth.example.com/oauth2/token',
              scopes: { 'washops/events.read': 'Read every site (dashboard users)' },
            },
          },
        },
      },
      schemas: {
        ...components(events, 'input'),
        ...components(
          {
            EventAccepted: eventAcceptedSchema,
            LocationSummary: locationSummarySchema,
            LocationList: locationListSchema,
            ProcessedEvent: processedEventSchema,
            RecentEvents: recentEventsSchema,
            HourlyStats: hourlyStatsSchema,
            Trend: trendSchema,
            Error: errorResponseSchema,
          },
          'output',
        ),
      },
    },
  };
}
