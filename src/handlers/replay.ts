import type { Context } from 'aws-lambda';
import { z } from 'zod';
import { archivePrefix, listArchiveKeys, readArchivedEvent } from '../aws/archive';
import { MAX_ENTRIES_PER_CALL, publishEvents } from '../aws/eventBus';
import { EVENT_TTL_DAYS, type EventItem, getEvent, toPublicEvent } from '../aws/eventStore';
import { enqueueEvents } from '../aws/queue';
import {
  eventIdSchema,
  locationIdSchema,
  type QueueEnvelope,
  toValidationIssues,
  washEventSchema,
} from '../domain/events';
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

/** Archive objects read at once. A site's day is ~1,500 objects (a heartbeat a minute plus washes). */
const READ_CONCURRENCY = 25;
/** Stop starting new reads with this much time left, so a run that can't finish still reports where it stopped. */
const TIME_RESERVE_MS = 20_000;

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('requeue'),
    date: z.iso.date(), // one day's archive partition, e.g. 2026-09-14
    locationId: locationIdSchema.optional(),
    dryRun: z.boolean().default(false),
    // Continues a run that stopped early: pass that run's `resumeAfter`.
    startAfter: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal('republish'),
    eventIds: z.array(eventIdSchema).min(1).max(500),
  }),
]);

/**
 * Requeueing is only safe while processed events are still recognised as duplicates, and their
 * records expire EVENT_TTL_DAYS after processing. Events received on this date or later are all
 * still on record; an earlier day could be counted twice. The archive expires sooner today, but this
 * keeps a longer-lived archive (moved to Glacier, say) from making an old replay unsafe.
 */
export function oldestRequeueDate(now: Date): string {
  return new Date(now.getTime() - (EVENT_TTL_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
}

type ReplayRequest = z.infer<typeof requestSchema>;
type RequeueRequest = Extract<ReplayRequest, { action: 'requeue' }>;
type RepublishRequest = Extract<ReplayRequest, { action: 'republish' }>;

async function requeue(
  { date, locationId, dryRun, startAfter }: RequeueRequest,
  context: Context,
  log: Logger,
) {
  const oldest = oldestRequeueDate(new Date());
  if (date < oldest) {
    throw new Error(
      `Refusing to requeue ${date}: processed events are only recognised as duplicates for ` +
        `${EVENT_TTL_DAYS} days, so this could count them twice. The oldest safe date is ${oldest}.`,
    );
  }

  const prefix = archivePrefix(date, locationId);
  const keys = await listArchiveKeys(prefix, startAfter);
  // Per run: a resumed run may queue a repeat receipt again, which the processor skips as a duplicate.
  const seen = new Set<string>();
  const notQueued: string[] = [];
  let requeued = 0;
  let repeatReceipts = 0;
  let invalid = 0;
  let resumeAfter: string | undefined;

  for (let start = 0; start < keys.length; start += READ_CONCURRENCY) {
    if (start > 0 && context.getRemainingTimeInMillis() < TIME_RESERVE_MS) {
      resumeAfter = keys[start - 1];
      break;
    }

    const chunk = keys.slice(start, start + READ_CONCURRENCY);
    const records = await Promise.all(chunk.map(async (key) => ({ key, record: await readArchivedEvent(key) })));
    const envelopes: QueueEnvelope[] = [];

    // In key order, so the event's first archived receipt is the one requeued.
    for (const { key, record } of records) {
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

      envelopes.push({
        correlationId: record.correlationId, // keeps the original trace
        receivedAt: record.receivedAt,
        archiveKey: key,
        event: parsed.data,
      });
    }

    const refused = dryRun ? [] : await enqueueEvents(envelopes);
    notQueued.push(...refused.map((envelope) => envelope.archiveKey));
    requeued += envelopes.length - refused.length;
  }

  if (notQueued.length > 0) {
    log.error('SQS refused some events after retries; run again to requeue them', { archiveKeys: notQueued });
  }
  if (resumeAfter) {
    log.warn('Stopped before the time limit; run again with startAfter to continue', { resumeAfter });
  }

  return {
    action: 'requeue',
    prefix,
    dryRun,
    archivedObjects: keys.length,
    requeued,
    repeatReceipts,
    invalid,
    failed: notQueued.length,
    complete: resumeAfter === undefined,
    ...(resumeAfter && { resumeAfter }),
  };
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
  const result =
    request.action === 'requeue' ? await requeue(request, context, log) : await republish(request, log);
  log.info('Replay complete', { result });
  return result;
};
