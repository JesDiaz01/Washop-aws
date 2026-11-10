import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, type GetObjectCommandInput, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, type SendMessageBatchCommandInput, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand, type GetCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toEventItem } from '../src/aws/eventStore';
import { washEventSchema } from '../src/domain/events';
import { handler, oldestRequeueDate } from '../src/handlers/replay';
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

/** `count` single-receipt wash events, evt-1 … evt-<count>, in S3 key order. */
const washes = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const eventId = `evt-${String(i + 1).padStart(3, '0')}`;
      return [`${prefix}${eventId}_corr.json`, archived(washCompletedPayload({ eventId }), 'corr')];
    }),
  );

const sentBatches = () =>
  sqsMock.commandCalls(SendMessageBatchCommand).map((call) => call.args[0].input.Entries!);

const eventIdOf = (entry: { MessageBody?: string }) => JSON.parse(entry.MessageBody!).event.eventId as string;

describe('replay (operator tool)', () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    ddbMock.reset();
    ebMock.reset();
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });
    // The day after the fixtures' date, so they stay inside the requeue window whenever this runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requeues archived events once each, keeping the original correlation ID and archive key', async () => {
    archive({
      [`${prefix}evt-1_corr-a.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-a'),
      [`${prefix}evt-1_corr-retry.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-retry'), // controller retry
      [`${prefix}evt-2_corr-b.json`]: archived(washCompletedPayload({ eventId: 'evt-2' }), 'corr-b'),
    });

    const result = await handler({ action: 'requeue', date: '2026-09-14', locationId: 'miami-01' }, lambdaContext);

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe(prefix);
    expect(result).toMatchObject({ archivedObjects: 3, requeued: 2, repeatReceipts: 1, invalid: 0, failed: 0, complete: true });

    const first = JSON.parse(sentBatches()[0]![0]!.MessageBody!);
    expect(first).toMatchObject({ correlationId: 'corr-a', archiveKey: `${prefix}evt-1_corr-a.json`, event: { eventId: 'evt-1' } });
  });

  it('sends to SQS in batches of ten', async () => {
    archive(washes(23));

    const result = await handler({ action: 'requeue', date: '2026-09-14' }, lambdaContext);

    expect(result).toMatchObject({ requeued: 23, failed: 0 });
    expect(sentBatches().map((entries) => entries.length)).toEqual([10, 10, 3]);
  });

  it('resends entries SQS refuses, and reports the ones it keeps refusing', async () => {
    archive(washes(3));
    // evt-002 fails once, then goes through; evt-003 fails every time.
    let evt002Failures = 0;
    sqsMock.on(SendMessageBatchCommand).callsFake((input: SendMessageBatchCommandInput) => ({
      Failed: input.Entries!.filter((entry) => {
        const eventId = eventIdOf(entry);
        if (eventId === 'evt-002') return evt002Failures++ === 0;
        return eventId === 'evt-003';
      }).map((entry) => ({ Id: entry.Id, Code: 'InternalError', SenderFault: false })),
    }));

    const result = await handler({ action: 'requeue', date: '2026-09-14' }, lambdaContext);

    expect(result).toMatchObject({ requeued: 2, failed: 1 });
    expect(sentBatches().map((entries) => entries.map(eventIdOf))).toEqual([
      ['evt-001', 'evt-002', 'evt-003'],
      ['evt-002', 'evt-003'],
      ['evt-003'],
    ]);
  });

  it('stops before the time limit and says where to resume', async () => {
    archive(washes(30));
    const almostOutOfTime = { ...lambdaContext, getRemainingTimeInMillis: () => 10_000 } as Context;

    const result = await handler({ action: 'requeue', date: '2026-09-14' }, almostOutOfTime);

    // The first 25 objects are always processed, so every run makes progress.
    expect(result).toMatchObject({ requeued: 25, complete: false, resumeAfter: `${prefix}evt-025_corr.json` });

    await handler({ action: 'requeue', date: '2026-09-14', startAfter: `${prefix}evt-025_corr.json` }, lambdaContext);
    expect(s3Mock.commandCalls(ListObjectsV2Command)[1]!.args[0].input.StartAfter).toBe(`${prefix}evt-025_corr.json`);
  });

  it('refuses a day whose events may no longer be recognised as duplicates', async () => {
    archive({});
    expect(oldestRequeueDate(new Date('2026-11-10T16:00:00Z'))).toBe('2026-08-13'); // 89 days back

    await expect(handler({ action: 'requeue', date: '2026-06-17' }, lambdaContext)).rejects.toThrow(
      'Refusing to requeue 2026-06-17',
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);

    await handler({ action: 'requeue', date: '2026-06-18' }, lambdaContext); // 89 days before 2026-09-15
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1);
  });

  it('skips archived payloads that no longer pass validation', async () => {
    archive({ [`${prefix}evt-bad_corr.json`]: archived(washCompletedPayload({ eventId: 'evt-bad', data: {} }), 'corr') });

    const result = await handler({ action: 'requeue', date: '2026-09-14' }, lambdaContext);

    expect(result).toMatchObject({ requeued: 0, invalid: 1 });
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it('only counts in a dry run', async () => {
    archive({ [`${prefix}evt-1_corr-a.json`]: archived(washCompletedPayload({ eventId: 'evt-1' }), 'corr-a') });

    const result = await handler({ action: 'requeue', date: '2026-09-14', dryRun: true }, lambdaContext);

    expect(result).toMatchObject({ dryRun: true, requeued: 1 });
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
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
