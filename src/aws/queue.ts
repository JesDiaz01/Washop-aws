import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { QueueEnvelope } from '../domain/events';
import { requireEnv } from '../shared/config';
import { getSqsClient } from './clients';

/** Hands the event to SQS. Once this resolves, SQS durably stores the message (retained up to 4 days). */
export async function enqueueEvent(envelope: QueueEnvelope): Promise<string | undefined> {
  const result = await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: requireEnv('EVENTS_QUEUE_URL'),
      MessageBody: JSON.stringify(envelope),
      // Attributes are visible in the console/CLI without parsing the body; handy when inspecting the DLQ.
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: envelope.event.eventType },
        correlationId: { DataType: 'String', StringValue: envelope.correlationId },
      },
    }),
  );

  return result.MessageId;
}
