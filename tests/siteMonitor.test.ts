import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/handlers/siteMonitor';
import { lambdaContext } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const run = () => handler({}, lambdaContext);

describe('site monitor (scheduled)', () => {
  beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    ddbMock.on(UpdateCommand).resolves({});
    snsMock.on(PublishCommand).resolves({ MessageId: 'sns-1' });
  });

  it('marks a silent site offline and sends one alert', async () => {
    const lastHeartbeat = minutesAgo(25);
    ddbMock.on(ScanCommand).resolves({ Items: [{ locationId: 'miami-01', lastHeartbeat }] });

    await run();

    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ locationId: 'miami-01' });
    expect(update.ExpressionAttributeValues).toMatchObject({ ':to': 'OFFLINE', ':seen': lastHeartbeat });
    // A heartbeat that lands after the scan makes this condition fail, so no false alert goes out.
    expect(update.ConditionExpression).toContain('lastHeartbeat = :seen');

    const publish = snsMock.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(publish.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:test-site-alerts');
    expect(publish.Subject).toBe('WashOps: miami-01 is offline');
    expect(publish.Message).toContain('25 minutes');
  });

  it('sends a recovery alert when an offline site is heartbeating again', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ locationId: 'miami-01', lastHeartbeat: minutesAgo(1), connectivity: 'OFFLINE' }] });

    await run();

    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':to': 'ONLINE',
    });
    expect(snsMock.commandCalls(PublishCommand)[0]!.args[0].input.Subject).toBe('WashOps: miami-01 is back online');
  });

  it('does nothing for healthy, already-offline, or never-reporting sites', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { locationId: 'healthy-01', lastHeartbeat: minutesAgo(2) },
        { locationId: 'still-down-01', lastHeartbeat: minutesAgo(90), connectivity: 'OFFLINE' },
        { locationId: 'new-site-01' },
      ],
    });

    await run();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it('does not alert when another run already recorded the change', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ locationId: 'miami-01', lastHeartbeat: minutesAgo(25) }] });
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));

    await run();

    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it('reverts the change and fails the run when the alert cannot be sent, so the next run retries', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ locationId: 'miami-01', lastHeartbeat: minutesAgo(25) }] });
    snsMock.on(PublishCommand).rejects(new Error('SNS unavailable'));

    await expect(run()).rejects.toThrow('1 connectivity change(s)');

    const [claim, revert] = ddbMock.commandCalls(UpdateCommand).map((call) => call.args[0].input);
    expect(claim!.ExpressionAttributeValues).toMatchObject({ ':to': 'OFFLINE' });
    expect(revert!.ConditionExpression).toBe('#connectivity = :to');
    expect(revert!.ExpressionAttributeValues).toMatchObject({ ':to': 'OFFLINE', ':from': 'ONLINE' });
  });

  it('reads every page of the summary table', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ locationId: 'a-01', lastHeartbeat: minutesAgo(30) }], LastEvaluatedKey: { locationId: 'a-01' } })
      .resolvesOnce({ Items: [{ locationId: 'b-01', lastHeartbeat: minutesAgo(30) }] });

    await run();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(ScanCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ locationId: 'a-01' });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(2);
  });
});
