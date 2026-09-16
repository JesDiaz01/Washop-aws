import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
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
