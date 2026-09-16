import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { archiveRawEvent } from '../aws/archive';
import { enqueueEvent } from '../aws/queue';
import { toValidationIssues, washEventSchema } from '../domain/events';
import { BadRequestError, HttpError } from '../shared/errors';
import { jsonResponse, parseJsonBody } from '../shared/http';
import { createLogger, serializeError } from '../shared/logger';

/**
 * POST /events
 *
 * validate -> archive raw payload to S3 -> enqueue to SQS -> 202 Accepted.
 * Deliberately does NOT touch DynamoDB: the API stays fast and available even if processing is slow or broken.
 */

const logger = createLogger({ service: 'washops-ingest' });

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Reuse the caller's correlation ID if it sent a sane one; otherwise start a new trace. */
function resolveCorrelationId(headers: APIGatewayProxyEventV2['headers']): string {
  const incoming = headers['x-correlation-id']; // HTTP API lower-cases header names
  return incoming && CORRELATION_ID_PATTERN.test(incoming) ? incoming : randomUUID();
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const startedAt = Date.now();
  const correlationId = resolveCorrelationId(event.headers ?? {});
  const responseHeaders = { 'x-correlation-id': correlationId };
  const log = logger.child({
    correlationId,
    awsRequestId: context.awsRequestId, // Lambda invocation ID
    apiRequestId: event.requestContext.requestId, // matches the API Gateway access log
  });

  try {
    const payload = parseJsonBody(event);

    const parsed = washEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadRequestError('Event failed validation', toValidationIssues(parsed.error));
    }
    const washEvent = parsed.data;
    const eventLog = log.child({
      eventId: washEvent.eventId,
      eventType: washEvent.eventType,
      locationId: washEvent.locationId,
    });
    eventLog.info('Event received');

    const receivedAt = new Date().toISOString();

    // 1) Durable raw audit record first...
    const archiveKey = await archiveRawEvent({
      eventId: washEvent.eventId,
      locationId: washEvent.locationId,
      correlationId,
      receivedAt,
      apiRequestId: event.requestContext.requestId,
      sourceIp: event.requestContext.http.sourceIp,
      userAgent: event.requestContext.http.userAgent,
      payload,
    });

    // 2) ...then hand off for asynchronous processing.
    const messageId = await enqueueEvent({ correlationId, receivedAt, archiveKey, event: washEvent });

    eventLog.info('Event accepted', { archiveKey, messageId, durationMs: Date.now() - startedAt });

    return jsonResponse(
      202,
      { message: 'Event accepted', eventId: washEvent.eventId, correlationId },
      responseHeaders,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      log.warn('Event rejected', { statusCode: error.statusCode, reason: error.message, details: error.details });
      return jsonResponse(
        error.statusCode,
        { message: error.message, correlationId, ...(error.details ? { errors: error.details } : {}) },
        responseHeaders,
      );
    }

    // S3/SQS unavailable after SDK retries, missing config, bugs. Don't leak internals to the caller.
    // The controller should retry; duplicate deliveries are safe because processing is idempotent.
    log.error('Failed to accept event', { error: serializeError(error), durationMs: Date.now() - startedAt });
    return jsonResponse(500, { message: 'Internal server error', correlationId }, responseHeaders);
  }
};
