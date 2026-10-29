import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { toEventItem } from '../src/aws/eventStore';
import { washEventSchema } from '../src/domain/events';
import { handler } from '../src/handlers/eventPublisher';
import { envelopeFor, heartbeatPayload, washCompletedPayload } from './fixtures';
import { lambdaContext } from './helpers';

const ebMock = mockClient(EventBridgeClient);

const now = new Date('2026-09-14T18:30:02.000Z');

/** A stream record exactly as DynamoDB writes it when the processor inserts an event item. */
function streamRecord(payload: object, sequenceNumber: string, eventName: DynamoDBRecord['eventName'] = 'INSERT') {
  const item = toEventItem(envelopeFor(washEventSchema.parse(payload)), now);
  return {
    eventName,
    dynamodb: { SequenceNumber: sequenceNumber, NewImage: marshall(item, { removeUndefinedValues: true }) },
  } as DynamoDBRecord;
}

const streamEvent = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

describe('event publisher (DynamoDB stream -> EventBridge)', () => {
  beforeEach(() => {
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'eb-1' }] });
  });

  it('publishes a newly processed event with its type as detail-type and storage fields removed', async () => {
    const result = await handler(streamEvent(streamRecord(washCompletedPayload(), '100')), lambdaContext);

    expect(result.batchItemFailures).toEqual([]);
    const [entry] = ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries!;
    expect(entry).toMatchObject({ EventBusName: 'test-event-bus', Source: 'washops', DetailType: 'WASH_COMPLETED' });

    const detail = JSON.parse(entry!.Detail!);
    expect(detail).toMatchObject({ eventId: 'evt-1001', locationId: 'miami-01', data: { amount: 22 } });
    expect(detail).not.toHaveProperty('expiresAt');
    expect(detail).not.toHaveProperty('activityAt');
  });

  it('skips heartbeats and anything that is not a new item', async () => {
    await handler(
      streamEvent(
        streamRecord(heartbeatPayload(), '100'),
        streamRecord(washCompletedPayload(), '101', 'MODIFY'),
        streamRecord(washCompletedPayload(), '102', 'REMOVE'), // TTL expiry
      ),
      lambdaContext,
    );

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it('reports only the entries EventBridge rejected', async () => {
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ EventId: 'eb-1' }, { ErrorCode: 'InternalFailure', ErrorMessage: 'try again' }],
    });

    const result = await handler(
      streamEvent(
        streamRecord(washCompletedPayload({ eventId: 'evt-ok' }), '100'),
        streamRecord(washCompletedPayload({ eventId: 'evt-rejected' }), '101'),
      ),
      lambdaContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: '101' }]);
  });

  it('retries the whole chunk when the PutEvents call fails', async () => {
    ebMock.on(PutEventsCommand).rejects(new Error('Rate exceeded'));

    const result = await handler(
      streamEvent(streamRecord(washCompletedPayload({ eventId: 'evt-a' }), '100'), streamRecord(washCompletedPayload({ eventId: 'evt-b' }), '101')),
      lambdaContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: '100' }, { itemIdentifier: '101' }]);
  });

  it('splits large batches into PutEvents calls of at most 10 entries', async () => {
    const records = Array.from({ length: 12 }, (_, i) => streamRecord(washCompletedPayload({ eventId: `evt-${i}` }), `${100 + i}`));

    await handler(streamEvent(...records), lambdaContext);

    const calls = ebMock.commandCalls(PutEventsCommand).map((call) => call.args[0].input.Entries!.length);
    expect(calls).toEqual([10, 2]);
  });
});
