import type { APIGatewayProxyEventV2WithJWTAuthorizer, Context, SQSEvent, SQSRecord } from 'aws-lambda';

export const lambdaContext = { awsRequestId: 'test-invocation-id' } as Context;

export const TEST_CLIENT_ID = 'test-site-client';

/** The demo site credential: may send events for miami-01 only. */
export const TEST_SCOPES = ['washops/events.write', 'washops/events.read', 'washops/site.miami-01'];

export function httpEvent(
  overrides: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
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
      // What API Gateway's JWT authorizer passes along after verifying a client-credentials token.
      authorizer: {
        principalId: '',
        integrationLatency: 0,
        jwt: {
          claims: { client_id: TEST_CLIENT_ID, token_use: 'access', scope: TEST_SCOPES.join(' ') },
          scopes: TEST_SCOPES,
        },
      },
    },
    ...overrides,
  } as APIGatewayProxyEventV2WithJWTAuthorizer;
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
