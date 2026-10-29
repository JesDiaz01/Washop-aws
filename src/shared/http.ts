import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { BadRequestError, PayloadTooLargeError } from './errors';

export const MAX_BODY_BYTES = 64 * 1024;

export function jsonResponse(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/**
 * The OAuth client that called the API (a Cognito app client ID). API Gateway's JWT authorizer has
 * already verified the token's signature, expiry, issuer, and scopes before the Lambda runs.
 */
export function callerClientId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined {
  const clientId = event.requestContext.authorizer?.jwt?.claims?.client_id;
  return typeof clientId === 'string' ? clientId : undefined;
}

/** The verified access token's OAuth scopes, e.g. washops/events.write and washops/site.miami-01. */
export function callerScopes(event: APIGatewayProxyEventV2WithJWTAuthorizer): string[] {
  const jwt = event.requestContext.authorizer?.jwt;
  if (jwt?.scopes) return jwt.scopes;
  const scope = jwt?.claims?.scope; // the raw claim is one space-separated string
  return typeof scope === 'string' ? scope.split(' ') : [];
}

/** Parses the JSON body of an API Gateway HTTP API (payload format 2.0) request. */
export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    throw new BadRequestError('Request body is required');
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError(MAX_BODY_BYTES);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError('Request body must be valid JSON');
  }
}
