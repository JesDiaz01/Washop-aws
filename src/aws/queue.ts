import { SendMessageBatchCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { QueueEnvelope } from '../domain/events';
import { requireEnv } from '../shared/config';
import { getSqsClient } from './clients';

const MAX_BATCH_ENTRIES = 10; // SQS limit per SendMessageBatch call
const BATCH_SEND_ATTEMPTS = 3;

function messageFor(envelope: QueueEnvelope) {
  return {
    MessageBody: JSON.stringify(envelope),
    // Attributes are visible in the console/CLI without parsing the body; handy when inspecting the DLQ.
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: envelope.event.eventType },
      correlationId: { DataType: 'String', StringValue: envelope.correlationId },
    },
  };
}

/** Hands the event to SQS. Once this resolves, SQS durably stores the message (retained up to 4 days). */
export async function enqueueEvent(envelope: QueueEnvelope): Promise<string | undefined> {
  const result = await getSqsClient().send(
    new SendMessageCommand({ QueueUrl: requireEnv('EVENTS_QUEUE_URL'), ...messageFor(envelope) }),
  );

  return result.MessageId;
}

/**
 * Bulk version for the replay tool: batches of 10, sent concurrently. A batch call can succeed while
 * some of its entries fail, so failed entries are resent; the ones SQS still refuses are returned.
 */
export async function enqueueEvents(envelopes: readonly QueueEnvelope[]): Promise<QueueEnvelope[]> {
  const batches: QueueEnvelope[][] = [];
  for (let start = 0; start < envelopes.length; start += MAX_BATCH_ENTRIES) {
    batches.push(envelopes.slice(start, start + MAX_BATCH_ENTRIES));
  }

  const refused = await Promise.all(batches.map(sendBatch));
  return refused.flat();
}

async function sendBatch(batch: QueueEnvelope[]): Promise<QueueEnvelope[]> {
  let pending = batch;
  for (let attempt = 1; attempt <= BATCH_SEND_ATTEMPTS && pending.length > 0; attempt += 1) {
    const result = await getSqsClient().send(
      new SendMessageBatchCommand({
        QueueUrl: requireEnv('EVENTS_QUEUE_URL'),
        Entries: pending.map((envelope, index) => ({ Id: String(index), ...messageFor(envelope) })),
      }),
    );
    const failedIds = new Set((result.Failed ?? []).map((entry) => entry.Id));
    pending = pending.filter((_, index) => failedIds.has(String(index)));
  }
  return pending;
}
