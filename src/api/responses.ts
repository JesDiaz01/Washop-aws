import { z } from 'zod';
import { EVENT_TYPES, eventIdSchema, locationIdSchema } from '../domain/events';

/**
 * Response bodies of the HTTP API. The handlers are typed against these, the unit tests parse real
 * handler responses with them (strictly: an undocumented field fails the test), and docs/openapi.json
 * is generated from them, so the published contract can't drift from what the code returns.
 */

const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
const dollars = z.number().meta({ description: 'Dollars, converted from the integer cents stored' });

export const errorResponseSchema = z.strictObject({
  message: z.string(),
  correlationId: z.string().optional().meta({ description: 'POST /events only' }),
  errors: z
    .array(z.strictObject({ path: z.string(), message: z.string() }))
    .optional()
    .meta({ description: 'One entry per invalid field (400 on POST /events)' }),
});

export const eventAcceptedSchema = z.strictObject({
  message: z.literal('Event accepted'),
  eventId: eventIdSchema,
  correlationId: z.string(),
  warnings: z
    .array(z.string())
    .optional()
    .meta({ description: "Present when the controller's clock looks wrong; the event is still accepted" }),
});

export const locationSummarySchema = z.strictObject({
  locationId: locationIdSchema,
  washesStarted: count,
  completedWashes: count,
  totalRevenue: dollars,
  paymentsCompleted: count,
  paymentVolume: dollars,
  equipmentFaults: count,
  lastHeartbeat: timestamp.nullable().meta({ description: 'Server receipt time of the latest heartbeat' }),
  controllerClockSkewSeconds: z
    .number()
    .nullable()
    .meta({ description: "From the latest heartbeat: how far the controller's clock is off (positive = ahead)" }),
  connectivity: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']).meta({ description: 'UNKNOWN: no heartbeat received yet' }),
  connectivityChangedAt: timestamp.nullable(),
  lastUpdated: timestamp.nullable(),
});

export const locationListSchema = z.strictObject({
  count,
  locations: z.array(locationSummarySchema).meta({ description: 'Sites this credential may read, sorted by ID' }),
});

export const processedEventSchema = z.strictObject({
  eventId: eventIdSchema,
  locationId: locationIdSchema,
  eventType: z.enum(EVENT_TYPES),
  occurredAt: timestamp.meta({ description: "The controller's timestamp, kept even when its clock is wrong" }),
  receivedAt: timestamp,
  processedAt: timestamp,
  correlationId: z.string(),
  archiveKey: z.string().meta({ description: 'S3 key of the raw payload as received' }),
  data: z.record(z.string(), z.unknown()).meta({ description: 'The validated data object for this eventType' }),
  clockSkewSeconds: z
    .number()
    .optional()
    .meta({ description: 'Present when the controller clock looked wrong: timestamp minus receivedAt' }),
});

export const recentEventsSchema = z.strictObject({
  locationId: locationIdSchema,
  count,
  events: z.array(processedEventSchema).meta({ description: 'Newest first; heartbeats are not listed' }),
});

export type EventAcceptedResponse = z.infer<typeof eventAcceptedSchema>;
export type LocationSummaryResponse = z.infer<typeof locationSummarySchema>;
export type LocationListResponse = z.infer<typeof locationListSchema>;
export type RecentEventsResponse = z.infer<typeof recentEventsSchema>;
