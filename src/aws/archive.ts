import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { requireEnv } from '../shared/config';
import { getS3Client } from './clients';

export interface RawEventRecord {
  eventId: string;
  locationId: string;
  correlationId: string;
  receivedAt: string;
  apiRequestId: string;
  /** The authenticated OAuth client (site credential) that sent the event. */
  clientId: string | undefined;
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

/** One day's archive, optionally narrowed to one site: the same partitions Athena uses. */
export function archivePrefix(date: string, locationId?: string): string {
  return locationId ? `raw/date=${date}/location=${locationId}/` : `raw/date=${date}/`;
}

export async function listArchiveKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: requireEnv('RAW_EVENTS_BUCKET'),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(...(page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])));
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

export async function readArchivedEvent(key: string): Promise<RawEventRecord> {
  const object = await getS3Client().send(new GetObjectCommand({ Bucket: requireEnv('RAW_EVENTS_BUCKET'), Key: key }));
  const body = await object.Body?.transformToString();
  if (!body) throw new Error(`Archived object ${key} is empty`);
  return JSON.parse(body) as RawEventRecord;
}
