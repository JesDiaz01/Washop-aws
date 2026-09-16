import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * AWS SDK clients, created lazily once per Lambda execution environment and reused across
 * invocations (keeps TCP/TLS connections warm).
 *
 * No credentials are configured here: in Lambda the SDK automatically uses the temporary
 * credentials of the function's IAM execution role. Region comes from AWS_REGION.
 *
 * maxAttempts: the SDK retries throttling and transient 5xx errors with exponential backoff + jitter.
 */
const sdkConfig = { maxAttempts: 3 };

let s3: S3Client | undefined;
let sqs: SQSClient | undefined;
let dynamo: DynamoDBDocumentClient | undefined;

export const getS3Client = () => (s3 ??= new S3Client(sdkConfig));

export const getSqsClient = () => (sqs ??= new SQSClient(sdkConfig));

/** DocumentClient converts plain JS objects to DynamoDB's typed attribute format. */
export const getDynamoClient = () =>
  (dynamo ??= DynamoDBDocumentClient.from(new DynamoDBClient(sdkConfig), {
    marshallOptions: { removeUndefinedValues: true },
  }));
