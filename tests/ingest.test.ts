import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/ingest';
import { washCompletedPayload } from './fixtures';
import { httpEvent, lambdaContext } from './helpers';

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(
    httpEvent({
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    }),
    lambdaContext,
  );

describe('ingest handler (POST /events)', () => {
  beforeEach(() => {
    s3Mock.reset();
    sqsMock.reset();
    s3Mock.on(PutObjectCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-1' });
  });

  it('archives to S3, enqueues to SQS, and returns 202 for a valid event', async () => {
    const response = await post(washCompletedPayload());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body!)).toMatchObject({ message: 'Event accepted', eventId: 'evt-1001' });

    const putInput = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(putInput.Bucket).toBe('test-raw-events');
    expect(putInput.Key).toMatch(/^raw\/date=\d{4}-\d{2}-\d{2}\/location=miami-01\/evt-1001_.+\.json$/);

    const message = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input.MessageBody!);
    expect(message.archiveKey).toBe(putInput.Key);
    expect(message.event).toMatchObject({ eventId: 'evt-1001', eventType: 'WASH_COMPLETED' });
  });

  it('propagates a caller-supplied correlation ID end to end', async () => {
    const response = await post(washCompletedPayload(), { 'x-correlation-id': 'controller-trace-123' });

    expect(response.headers?.['x-correlation-id']).toBe('controller-trace-123');
    const message = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input.MessageBody!);
    expect(message.correlationId).toBe('controller-trace-123');
  });

  it('returns 400 with field errors and touches no AWS resources for an invalid event', async () => {
    const response = await post(washCompletedPayload({ locationId: 'Miami 01!' }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body!).errors).toEqual([{ path: 'locationId', message: expect.any(String) }]);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 for an unsupported event type', async () => {
    const response = await post(washCompletedPayload({ eventType: 'CAR_TELEPORTED' }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('eventType must be one of');
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await post('{"eventId": ');

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body!).message).toBe('Request body must be valid JSON');
  });

  it('returns 500 and does not enqueue when the S3 archive fails', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 unavailable'));

    const response = await post(washCompletedPayload());

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body!).message).toBe('Internal server error'); // no internals leaked
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
