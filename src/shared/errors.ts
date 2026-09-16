/** Errors that map directly to an HTTP response. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(maxBytes: number) {
    super(413, `Request body exceeds ${maxBytes} bytes`);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

/**
 * An SQS message that can never be processed successfully (malformed JSON, schema mismatch).
 * Retrying won't help; it is reported as failed so SQS eventually moves it to the DLQ for inspection.
 */
export class InvalidMessageError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}
