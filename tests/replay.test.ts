import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, type GetObjectCommandInput, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand, type GetCommandInput } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { toEventItem } from '../src/aws/eventStore';
import { washEventSchema } from '../src/domain/events';
import { handler } from '../src/handlers/replay';
import { envelopeFor, washCompletedPayload } from './fixtures';
import { lambdaContext } from './helpers';

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

const prefix = 'raw/date=2026-09-14/location=miami-01/';

/** What the ingest Lambda archived, keyed by S3 object key. */
function archive(objects: Record<string, object>) {
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: Object.keys(objects).map((Key) => ({ Key })) });
  s3Mock.on(GetObjectCommand).callsFake((input: GetObjectCommandInput) => ({
    Body: { transformToString: async () => JSON.stringify(objects[input.Key!]) },
  }));
}

const archived = (payload: object, correlationId: string) => ({
  eventId: (payload as { eventId: string }).eventId,
  locationId: 'miami-01',
  correlationId,
  receivedAt: '2026-09-14T18:30:01.000Z',
  apiRequestId: 'api-1',
  clientId: 'site-client',
  sourceIp: '203.0.113.10',
  userAgent: 'controller/4.2',
  payload,
});

describe('replay (operator tool)', () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    ddbMock.reset();
    ebMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-1' });
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
  });

  it('requeues archived events once each, keeping the original correlation ID and archive key', async () => {
    archive({
      [`${prefix}evt-1_corr-a.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-a'),
      [`${prefix}evt-1_corr-retry.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-retry'), // controller retry
      [`${prefix}evt-2_corr-b.json`]: archived(washCompletedPayload({ eventId: 'evt-2' }), 'corr-b'),
    });

    const result = await handler({ action: 'requeue', date: '2026-09-14', locationId: 'miami-01' }, lambdaContext);

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe(prefix);
    expect(result).toMatchObject({ archivedObjects: 3, requeued: 2, repeatReceipts: 1, invalid: 0 });

    const first = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input.MessageBody!);
    expect(first).toMatchObject({ correlationId: 'corr-a', archiveKey: `${prefix}evt-1_corr-a.json`, event: { eventId: 'evt-1' } });
  });

  it('skips archived payloads that no longer pass validation', async () => {
    archive({ [`${prefix}evt-bad_corr.json`]: archived(washCompletedPayload({ eventId: 'evt-bad', data: {} }), 'corr') });

    const result = await handler({ action: 'requeue', date: '2026-09-14' }, lambdaContext);

    expect(result).toMatchObject({ requeued: 0, invalid: 1 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('only counts in a dry run', async () => {
    archive({ [`${prefix}evt-1_corr-a.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-a') });

    const result = await handler({ action: 'requeue', date: '2026-09-14', dryRun: true }, lambdaContext);

    expect(result).toMatchObject({ dryRun: true, requeued: 1 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('republishes processed events to EventBridge and reports the ones it cannot find', async () => {
    const item = toEventItem(envelopeFor(washEventSchema.parse(washCompletedPayload({ eventId: 'evt-1' }))), new Date());
    ddbMock.on(GetCommand).callsFake((input: GetCommandInput) => ({ Item: input.Key?.eventId === 'evt-1' ? item : undefined }));

    const result = await handler({ action: 'republish', eventIds: ['evt-1', 'evt-gone', 'evt-1'] }, lambdaContext);

    expect(result).toEqual({ action: 'republish', requested: 2, published: 1, notFound: ['evt-gone'], failed: [] });
    const [entry] = ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries!;
    expect(entry).toMatchObject({ DetailType: 'WASH_COMPLETED' });
  });

  it('rejects a malformed request before touching AWS', async () => {
    await expect(handler({ action: 'requeue', date: 'yesterday' }, lambdaContext)).rejects.toThrow('Invalid replay request');
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });
});
