import type { APIGatewayProxyEventV2, Context, SQSEvent, SQSRecord } from 'aws-lambda';

export const lambdaContext = { awsRequestId: 'test-invocation-id' } as Context;

export function httpEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /events',
    rawPath: '/events',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    isBase64Encoded: false,
    requestContext: {
      requestId: 'api-request-id',
      http: { method: 'POST', path: '/events', protocol: 'HTTP/1.1', sourceIp: '203.0.113.10', userAgent: 'vitest' },
    },
    ...overrides,
  } as APIGatewayProxyEventV2;
}

export function sqsEvent(bodies: { messageId: string; body: string }[]): SQSEvent {
  return {
    Records: bodies.map(
      ({ messageId, body }) =>
        ({
          messageId,
          body,
          receiptHandle: `rh-${messageId}`,
          attributes: { ApproximateReceiveCount: '1' },
          messageAttributes: {},
          eventSource: 'aws:sqs',
        }) as unknown as SQSRecord,
    ),
  };
}
