import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { washEventSchema } from '../src/domain/events';
import { handler } from '../src/handlers/processor';
import { envelopeFor, heartbeatPayload, washCompletedPayload } from './fixtures';
import { lambdaContext, sqsEvent } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);

const messageFor = (payload: object, messageId = 'msg-1') => ({
  messageId,
  body: JSON.stringify(envelopeFor(washEventSchema.parse(payload))),
});

describe('processor handler (SQS consumer)', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
  });

  it('records a WASH_COMPLETED event and increments counters in one transaction', async () => {
    const result = await handler(sqsEvent([messageFor(washCompletedPayload())]), lambdaContext);

    expect(result.batchItemFailures).toEqual([]);

    const [put, update] = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(put!.Put).toMatchObject({
      TableName: 'test-events',
      ConditionExpression: 'attribute_not_exists(eventId)',
      Item: { eventId: 'evt-1001', locationId: 'miami-01', correlationId: 'corr-test-0001' },
    });
    expect(update!.Update).toMatchObject({ TableName: 'test-location-summary', Key: { locationId: 'miami-01' } });
    expect(update!.Update!.UpdateExpression).toMatch(/^ADD #c0 :c0, #c1 :c1 SET #lastUpdated = :now$/);
    expect(update!.Update!.ExpressionAttributeNames).toMatchObject({ '#c0': 'completedWashes', '#c1': 'washRevenueCents' });
    expect(update!.Update!.ExpressionAttributeValues).toMatchObject({ ':c0': 1, ':c1': 2200 });
  });

  it('treats a duplicate delivery as success without double counting', async () => {
    // What DynamoDB returns when the idempotency condition (item 0) fails.
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );

    const result = await handler(sqsEvent([messageFor(washCompletedPayload())]), lambdaContext);

    // Not reported as a failure -> SQS deletes it instead of retrying forever.
    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('reports only the failed message when DynamoDB throws (e.g. throttling)', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' }));

    const result = await handler(
      sqsEvent([
        messageFor(washCompletedPayload({ eventId: 'evt-ok' }), 'msg-ok'),
        messageFor(washCompletedPayload({ eventId: 'evt-throttled' }), 'msg-throttled'),
      ]),
      lambdaContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-throttled' }]);
  });

  it('reports poison messages as failures so they reach the DLQ, without blocking the rest of the batch', async () => {
    const result = await handler(
      sqsEvent([
        { messageId: 'msg-garbage', body: 'not json at all' },
        { messageId: 'msg-bad-schema', body: JSON.stringify({ event: { eventType: 'WASH_COMPLETED' } }) },
        messageFor(washCompletedPayload(), 'msg-good'),
      ]),
      lambdaContext,
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'msg-garbage' }, { itemIdentifier: 'msg-bad-schema' }]);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('ignores a stale heartbeat that arrives after a newer one', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));

    const result = await handler(sqsEvent([messageFor(heartbeatPayload())]), lambdaContext);

    expect(result.batchItemFailures).toEqual([]);
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.ConditionExpression).toBe('attribute_not_exists(lastHeartbeat) OR lastHeartbeat < :ts');
    // Heartbeats are kept out of the location activity GSI (sparse index).
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item).not.toHaveProperty('activityAt');
  });
});
