import { z } from 'zod';

/**
 * The event contract between car wash controllers and WashOps.
 *
 * Unknown properties are stripped rather than rejected (a "tolerant reader"),
 * so newer controller firmware can add fields without breaking ingestion.
 * The untouched original payload is still preserved in the S3 archive.
 */

export const EVENT_TYPES = [
  'WASH_STARTED',
  'WASH_COMPLETED',
  'PAYMENT_COMPLETED',
  'EQUIPMENT_FAULT',
  'CONTROLLER_HEARTBEAT',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// IDs end up in S3 object keys and DynamoDB keys, so restrict them to safe characters.
export const eventIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'eventId must be 1-128 characters: letters, digits, . _ : -');

export const locationIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{2,64}$/, 'locationId must be 2-64 characters: lowercase letters, digits, -');

// Accept any ISO-8601 timestamp with an offset, but normalize to UTC ("...Z")
// so stored timestamps sort correctly as strings.
const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

// Money arrives as decimal dollars (e.g. 22.00) and is converted to integer cents before storage.
const amountSchema = z
  .number()
  .nonnegative()
  .max(10_000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: 'amount must have at most 2 decimal places',
  });

const shortText = z.string().trim().min(1).max(64);

const base = {
  eventId: eventIdSchema,
  locationId: locationIdSchema,
  timestamp: timestampSchema,
};

export const washStartedSchema = z.object({
  ...base,
  eventType: z.literal('WASH_STARTED'),
  data: z.object({
    washPackage: shortText,
    bayId: shortText.optional(),
  }),
});

export const washCompletedSchema = z.object({
  ...base,
  eventType: z.literal('WASH_COMPLETED'),
  data: z.object({
    washPackage: shortText,
    amount: amountSchema,
    durationSeconds: z.number().int().nonnegative().max(3_600),
  }),
});

export const paymentCompletedSchema = z.object({
  ...base,
  eventType: z.literal('PAYMENT_COMPLETED'),
  data: z.object({
    amount: amountSchema,
    paymentMethod: z.enum(['CARD', 'CASH', 'MOBILE', 'MEMBERSHIP']),
    transactionId: shortText.optional(),
  }),
});

export const equipmentFaultSchema = z.object({
  ...base,
  eventType: z.literal('EQUIPMENT_FAULT'),
  data: z.object({
    equipmentId: shortText,
    faultCode: shortText,
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    message: z.string().max(500).optional(),
  }),
});

export const controllerHeartbeatSchema = z.object({
  ...base,
  eventType: z.literal('CONTROLLER_HEARTBEAT'),
  data: z.object({
    controllerId: shortText,
    firmwareVersion: shortText.optional(),
    uptimeSeconds: z.number().int().nonnegative().optional(),
  }),
});

export const washEventSchema = z.discriminatedUnion(
  'eventType',
  [
    washStartedSchema,
    washCompletedSchema,
    paymentCompletedSchema,
    equipmentFaultSchema,
    controllerHeartbeatSchema,
  ],
  {
    error: (issue) =>
      issue.code === 'invalid_union'
        ? `eventType must be one of: ${EVENT_TYPES.join(', ')}`
        : undefined,
  },
);

export type WashEvent = z.infer<typeof washEventSchema>;

/**
 * What the ingestion Lambda puts on the SQS queue: the validated event plus
 * tracing/audit metadata that the processor carries into DynamoDB.
 */
export const queueEnvelopeSchema = z.object({
  correlationId: z.string().min(1),
  receivedAt: z.iso.datetime(),
  archiveKey: z.string().min(1),
  event: washEventSchema,
});

export type QueueEnvelope = z.infer<typeof queueEnvelopeSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}
