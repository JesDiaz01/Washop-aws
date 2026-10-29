import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { archivePrefix, listArchiveKeys, readArchivedEvent } from '../aws/archive';
import { MAX_ENTRIES_PER_CALL, publishEvents } from '../aws/eventBus';
import { type EventItem, getEvent, toPublicEvent } from '../aws/eventStore';
import { enqueueEvent } from '../aws/queue';
import { eventIdSchema, locationIdSchema, toValidationIssues, washEventSchema } from '../domain/events';
import { createLogger, type Logger } from '../shared/logger';

/**
 * Operator tool, invoked by hand (`aws lambda invoke`; see the README runbook). Two actions:
 *
 *   requeue    Re-sends archived raw events from S3 to the processing queue. Recovers events that
 *              were accepted but never processed: purged from the DLQ, or older than the queue's
 *              4-day retention after a long outage. Over-selecting is safe: processing is
 *              idempotent, so events that were already processed are skipped as duplicates.
 *
 *   republish  Re-publishes processed events to EventBridge by eventId, for events the publisher
 *              could not deliver (see the publisher-failures alarm). Requeueing can't do this,
 *              because a duplicate never re-enters the stream.
 */

const logger = createLogger({ service: 'washops-replay' });

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('requeue'),
    date: z.iso.date(), // one day's archive partition, e.g. 2026-09-14
    locationId: locationIdSchema.optional(),
    dryRun: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('republish'),
    eventIds: z.array(eventIdSchema).min(1).max(500),
  }),
]);

type ReplayRequest = z.infer<typeof requestSchema>;
type RequeueRequest = Extract<ReplayRequest, { action: 'requeue' }>;
type RepublishRequest = Extract<ReplayRequest, { action: 'republish' }>;

async function requeue({ date, locationId, dryRun }: RequeueRequest, log: Logger) {
  const prefix = archivePrefix(date, locationId);
  const keys = await listArchiveKeys(prefix);
  const seen = new Set<string>();
  let requeued = 0;
  let repeatReceipts = 0;
  let invalid = 0;

  for (const key of keys) {
    const record = await readArchivedEvent(key);
    // Re-validate: the schema may have changed since the event was archived.
    const parsed = washEventSchema.safeParse(record.payload);
    if (!parsed.success) {
      invalid += 1;
      log.warn('Archived payload does not pass current validation; skipped', {
        key,
        errors: toValidationIssues(parsed.error),
      });
      continue;
    }

    // A controller retry archives one object per receipt; queue each event once.
    if (seen.has(parsed.data.eventId)) {
      repeatReceipts += 1;
      continue;
    }
    seen.add(parsed.data.eventId);

    if (!dryRun) {
      await enqueueEvent({
        correlationId: record.correlationId, // keeps the original trace
        receivedAt: record.receivedAt,
        archiveKey: key,
        event: parsed.data,
      });
    }
    requeued += 1;
  }

  return { action: 'requeue', prefix, dryRun, archivedObjects: keys.length, requeued, repeatReceipts, invalid };
}

async function republish({ eventIds }: RepublishRequest, log: Logger) {
  const unique = [...new Set(eventIds)];
  const notFound: string[] = [];
  const failed: string[] = [];
  let published = 0;

  for (let start = 0; start < unique.length; start += MAX_ENTRIES_PER_CALL) {
    const chunk = unique.slice(start, start + MAX_ENTRIES_PER_CALL);
    const items = await Promise.all(chunk.map((eventId) => getEvent(eventId)));
    const found = items.filter((item): item is EventItem => item !== undefined);
    notFound.push(...chunk.filter((_, i) => items[i] === undefined));

    const failedIndexes = await publishEvents(found.map(toPublicEvent));
    failed.push(...failedIndexes.flatMap((i) => found[i]?.eventId ?? []));
    published += found.length - failedIndexes.length;
  }

  if (notFound.length > 0) {
    log.warn('Some events were not found (never processed, or expired by TTL)', { notFound });
  }
  return { action: 'republish', requested: unique.length, published, notFound, failed };
}

export const handler = async (event: unknown, context: Context) => {
  const log = logger.child({ awsRequestId: context.awsRequestId });

  const parsed = requestSchema.safeParse(event);
  if (!parsed.success) {
    throw new Error(`Invalid replay request: ${JSON.stringify(toValidationIssues(parsed.error))}`);
  }

  const request = parsed.data;
  log.info('Replay started', { request });
  const result = request.action === 'requeue' ? await requeue(request, log) : await republish(request, log);
  log.info('Replay complete', { result });
  return result;
};
