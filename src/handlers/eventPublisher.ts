import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  Context,
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { MAX_ENTRIES_PER_CALL, publishEvents } from '../aws/eventBus';
import { type EventItem, toPublicEvent } from '../aws/eventStore';
import { createLogger, serializeError } from '../shared/logger';

/**
 * DynamoDB Streams consumer: publishes each newly processed event to the EventBridge bus, where
 * other systems (maintenance, loyalty, BI) subscribe with rules instead of calling this service.
 *
 * Publishing from the stream rather than from the processor avoids a dual write: an event is
 * published only if its DynamoDB transaction committed, and a duplicate delivery, which never
 * inserts a new item, never produces a second stream record.
 */

const logger = createLogger({ service: 'washops-event-publisher' });

interface Publishable {
  sequenceNumber: string;
  item: EventItem;
}

/** The event source mapping's filter already does this; repeated here so the code stands on its own. */
function toPublishable(record: DynamoDBRecord): Publishable | undefined {
  const image = record.dynamodb?.NewImage;
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  if (record.eventName !== 'INSERT' || !image || !sequenceNumber) return undefined;

  // aws-lambda and the AWS SDK each declare their own (identical) AttributeValue type.
  const item = unmarshall(image as Record<string, AttributeValue>) as EventItem;
  return item.eventType === 'CONTROLLER_HEARTBEAT' ? undefined : { sequenceNumber, item };
}

export const handler = async (event: DynamoDBStreamEvent, context: Context): Promise<DynamoDBBatchResponse> => {
  const log = logger.child({ awsRequestId: context.awsRequestId });
  const publishable = event.Records.flatMap((record) => toPublishable(record) ?? []);
  const batchItemFailures: DynamoDBBatchItemFailure[] = [];

  for (let start = 0; start < publishable.length; start += MAX_ENTRIES_PER_CALL) {
    const chunk = publishable.slice(start, start + MAX_ENTRIES_PER_CALL);
    try {
      const failedIndexes = await publishEvents(chunk.map(({ item }) => toPublicEvent(item)));
      for (const index of failedIndexes) {
        const failed = chunk[index];
        if (!failed) continue;
        log.error('EventBridge rejected an event; it will be retried', {
          eventId: failed.item.eventId,
          correlationId: failed.item.correlationId,
        });
        batchItemFailures.push({ itemIdentifier: failed.sequenceNumber });
      }
    } catch (error) {
      // The whole call failed (throttling, network): retry every event in this chunk.
      log.error('Failed to publish events; they will be retried', {
        eventIds: chunk.map(({ item }) => item.eventId),
        error: serializeError(error),
      });
      batchItemFailures.push(...chunk.map(({ sequenceNumber }) => ({ itemIdentifier: sequenceNumber })));
    }
  }

  log.info('Stream batch published', {
    received: event.Records.length,
    published: publishable.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  // Lambda retries from the earliest failed record, so records after it may be published again;
  // subscribers dedupe on eventId.
  return { batchItemFailures };
};
