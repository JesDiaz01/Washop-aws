import type { Context, SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { recordEvent } from '../aws/eventStore';
import { type QueueEnvelope, queueEnvelopeSchema, toValidationIssues } from '../domain/events';
import { InvalidMessageError } from '../shared/errors';
import { createLogger, serializeError } from '../shared/logger';

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

async function processRecord(record: SQSRecord, context: Context): Promise<void> {
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
    } else {
      eventLog.info('Event processed', { outcome });
    }
  } catch (error) {
    eventLog.error('Failed to record event; message will be retried', { error: serializeError(error) });
    throw error;
  }
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  // Sequential keeps logs readable and load on DynamoDB predictable; batches are at most 10 messages.
  for (const record of event.Records) {
    try {
      await processRecord(record, context);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logger.info('Batch complete', {
    awsRequestId: context.awsRequestId,
    received: event.Records.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
};
