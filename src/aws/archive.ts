import { PutObjectCommand } from '@aws-sdk/client-s3';
import { requireEnv } from '../shared/config';
import { getS3Client } from './clients';

export interface RawEventRecord {
  eventId: string;
  locationId: string;
  correlationId: string;
  receivedAt: string;
  apiRequestId: string;
  sourceIp: string | undefined;
  userAgent: string | undefined;
  /** The request body exactly as the controller sent it (before validation strips anything). */
  payload: unknown;
}

/**
 * Builds a Hive-style key (date=/location=) so the archive can later be queried with Athena
 * without moving data. Every receipt gets its own object (eventId + correlationId), so a
 * retried request never overwrites the audit record of the original attempt.
 */
export function buildArchiveKey(record: Pick<RawEventRecord, 'eventId' | 'locationId' | 'correlationId' | 'receivedAt'>) {
  const date = record.receivedAt.slice(0, 10);
  return `raw/date=${date}/location=${record.locationId}/${record.eventId}_${record.correlationId}.json`;
}

export async function archiveRawEvent(record: RawEventRecord): Promise<string> {
  const key = buildArchiveKey(record);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: requireEnv('RAW_EVENTS_BUCKET'),
      Key: key,
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }),
  );

  return key;
}
