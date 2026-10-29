import type { Context, SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { recordEvent, type RecordOutcome } from '../aws/eventStore';
import { clockSkewSeconds, isClockSuspect } from '../domain/clock';
import { type QueueEnvelope, queueEnvelopeSchema, toValidationIssues } from '../domain/events';
import { InvalidMessageError } from '../shared/errors';
import { createLogger, serializeError } from '../shared/logger';
import { metricFields } from '../shared/metrics';

/**
 * SQS consumer. Lambda polls the queue and invokes this with a batch of messages.
 *
 * Returns partial batch failures: only failed message IDs go back to the queue for retry.
 * A message that fails maxReceiveCount times is moved to the dead-letter queue by SQS.
 */

const logger = createLogger({ service: 'washops-processor' });

export function parseQueueMessage(body: string): QueueEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('Message body is not valid JSON');
  }

  // Re-validate: the queue is a trust boundary too (other producers, schema drift between deploys).
  const parsed = queueEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidMessageError('Message does not match the queue envelope schema', toValidationIssues(parsed.error));
  }
  return parsed.data;
}

interface RecordResult {
  outcome: RecordOutcome;
  clockSuspect: boolean;
}

async function processRecord(record: SQSRecord, context: Context): Promise<RecordResult> {
  const log = logger.child({
    awsRequestId: context.awsRequestId,
    messageId: record.messageId,
    receiveCount: Number(record.attributes.ApproximateReceiveCount),
  });

  let envelope: QueueEnvelope;
  try {
    envelope = parseQueueMessage(record.body);
  } catch (error) {
    log.error('Poison message: cannot be parsed; will end up in the DLQ after max receives', {
      error: serializeError(error),
      details: error instanceof InvalidMessageError ? error.details : undefined,
    });
    throw error;
  }

  const { event } = envelope;
  const eventLog = log.child({
    correlationId: envelope.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    locationId: event.locationId,
  });

  try {
    const outcome = await recordEvent(envelope);
    if (outcome === 'DUPLICATE') {
      eventLog.warn('Duplicate event skipped (already processed)', { outcome });
      return { outcome, clockSuspect: false };
    }

    eventLog.info('Event processed', { outcome });
    const clockSuspect = isClockSuspect(event, envelope.receivedAt);
    if (clockSuspect) {
      eventLog.warn('Controller clock looks wrong', {
        clockSkewSeconds: clockSkewSeconds(event.timestamp, envelope.receivedAt),
      });
    }
    return { outcome, clockSuspect };
  } catch (error) {
    eventLog.error('Failed to record event; message will be retried', { error: serializeError(error) });
    throw error;
  }
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  let processed = 0;
  let duplicates = 0;
  let clockSkewed = 0;

  // Sequential keeps logs readable and load on DynamoDB predictable; batches are at most 10 messages.
  for (const record of event.Records) {
    try {
      const { outcome, clockSuspect } = await processRecord(record, context);
      if (outcome === 'DUPLICATE') {
        duplicates += 1;
      } else {
        processed += 1;
      }
      if (clockSuspect) clockSkewed += 1;
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logger.info('Batch complete', {
    awsRequestId: context.awsRequestId,
    received: event.Records.length,
    failed: batchItemFailures.length,
    ...metricFields({ EventsProcessed: processed, DuplicateEvents: duplicates, ClockSkewedEvents: clockSkewed }),
  });

  return { batchItemFailures };
};
