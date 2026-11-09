#!/usr/bin/env node
/**
 * Load test: sends WASH_COMPLETED events to a deployed stack at a steady rate, mixes in duplicate
 * deliveries, then checks that every event was counted exactly once and nothing reached the DLQ.
 *
 * Usage: node scripts/load-test.mjs [stackName] [--events 1000] [--rate 20] [--duplicates 0.05]
 *
 * Reads the stack's outputs and the demo site's credential with the AWS CLI, like the integration
 * tests. It writes real data, so it refuses to run against prod (the `washops` stack).
 *
 * Requests start on a fixed schedule whether or not earlier ones have finished (an open-loop
 * test), so slow responses show up in the latency numbers instead of quietly lowering the rate.
 * Keep --rate under the API's throttle (25 requests/s); above it API Gateway answers 429, which
 * this script retries with backoff, the way a controller would. Latency is measured from this
 * machine, so it includes the network round trip to us-east-1.
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const stackName = args[0] && !args[0].startsWith('--') ? args[0] : 'washops-dev';
const totalEvents = option('events', 1000);
const rate = option('rate', 20);
const duplicateShare = option('duplicates', 0.05);

if (stackName === 'washops') {
  console.error('Refusing to load-test prod: this writes real events. Use a dev stack (default washops-dev).');
  process.exit(1);
}

const aws = (...cli) => execFileSync('aws', cli, { encoding: 'utf8' }).trim();
const outputs = Object.fromEntries(
  JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', stackName, '--query', 'Stacks[0].Outputs', '--output', 'json')).map(
    ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
  ),
);
const api = outputs.ApiBaseUrl.replace(/\/$/, '');
const clientSecret = aws(
  'cognito-idp', 'describe-user-pool-client', '--user-pool-id', outputs.UserPoolId,
  '--client-id', outputs.SiteControllerClientId, '--query', 'UserPoolClient.ClientSecret', '--output', 'text',
);

// One token for the whole run, as a controller would cache it (Cognito bills per token request).
const tokenResponse = await fetch(outputs.TokenUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    authorization: `Basic ${Buffer.from(`${outputs.SiteControllerClientId}:${clientSecret}`).toString('base64')}`,
  },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
});
if (!tokenResponse.ok) throw new Error(`Token request failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
const { access_token: token } = await tokenResponse.json();
const scopes = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).scope.split(' ');
const locationId = scopes.find((scope) => scope.startsWith('washops/site.')).slice('washops/site.'.length);

const authorized = { authorization: `Bearer ${token}` };
const summary = async () => (await (await fetch(`${api}/locations/${locationId}/summary`, { headers: authorized })).json());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Build the workload: unique events, plus duplicate deliveries of some of them -------------------

const run = Date.now().toString(36);
const AMOUNT = 10; // dollars per wash, so expected revenue is exact
const events = Array.from({ length: totalEvents }, (_, i) => ({
  eventId: `load-${run}-${i}`,
  locationId,
  eventType: 'WASH_COMPLETED',
  timestamp: new Date().toISOString(),
  data: { washPackage: 'Express', amount: AMOUNT, durationSeconds: 240 },
}));
const duplicates = Array.from({ length: Math.round(totalEvents * duplicateShare) }, (_, i) => events[(i * 37) % totalEvents]);
const requests = [...events, ...duplicates];
for (let i = requests.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1)); // Fisher-Yates: duplicates land anywhere in the run
  [requests[i], requests[j]] = [requests[j], requests[i]];
}

// --- Send at a fixed rate --------------------------------------------------------------------------

const before = await summary();
const latencies = [];
const statuses = {};
let retries = 0;
let failures = 0;

async function send(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = performance.now();
    try {
      const response = await fetch(`${api}/events`, {
        method: 'POST',
        headers: { ...authorized, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, timestamp: new Date().toISOString() }),
      });
      await response.arrayBuffer();
      latencies.push(performance.now() - started);
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      if (response.status === 202) return;
      if (response.status !== 429 && response.status < 500) break; // a client error won't succeed on retry
    } catch {
      statuses.network = (statuses.network ?? 0) + 1;
    }
    retries += 1;
    await sleep(200 * 2 ** attempt + Math.random() * 100); // exponential backoff with jitter
  }
  failures += 1;
}

console.log(`Sending ${requests.length} requests (${events.length} events + ${duplicates.length} duplicates) to ${stackName} at ${rate}/s...`);
const startedAt = performance.now();
const inFlight = [];
for (let i = 0; i < requests.length; i++) {
  const due = startedAt + (i * 1000) / rate;
  const wait = due - performance.now();
  if (wait > 0) await sleep(wait);
  inFlight.push(send(requests[i]));
}
await Promise.all(inFlight);
const sendSeconds = (performance.now() - startedAt) / 1000;

// --- Wait for asynchronous processing, then check the counters --------------------------------------

const expectedWashes = before.completedWashes + events.length;
const drainStarted = Date.now();
let after = await summary();
while (after.completedWashes < expectedWashes && Date.now() - drainStarted < 180_000) {
  await sleep(2_000);
  after = await summary();
}
const drainSeconds = (Date.now() - drainStarted) / 1000;
await sleep(10_000); // any double count would surface after the queue drains
after = await summary();

const recent = await (await fetch(`${api}/locations/${locationId}/events?limit=50`, { headers: authorized })).json();
const processingMs = recent.events
  .filter((event) => event.eventId.startsWith(`load-${run}-`))
  .map((event) => Date.parse(event.processedAt) - Date.parse(event.receivedAt));
const dlqDepth = Number(
  aws('sqs', 'get-queue-attributes', '--queue-url', outputs.DeadLetterQueueUrl, '--attribute-names', 'ApproximateNumberOfMessages',
    '--query', 'Attributes.ApproximateNumberOfMessages', '--output', 'text'),
);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]) : NaN;
};
const countedWashes = after.completedWashes - before.completedWashes;
const countedRevenue = Math.round((after.totalRevenue - before.totalRevenue) * 100) / 100;

const results = {
  requests: requests.length,
  achievedRatePerSecond: Math.round((requests.length / sendSeconds) * 10) / 10,
  statuses,
  retries,
  failedAfterRetries: failures,
  apiLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: percentile(latencies, 100) },
  processingLatencyMs: { sampled: processingMs.length, p50: percentile(processingMs, 50), p95: percentile(processingMs, 95), max: percentile(processingMs, 100) },
  queueDrainedSecondsAfterLastSend: drainSeconds,
  washesCounted: `${countedWashes} of ${events.length} unique (${duplicates.length} duplicates sent)`,
  revenueCounted: `$${countedRevenue} (expected $${events.length * AMOUNT})`,
  deadLetterQueueDepth: dlqDepth,
};
console.log(JSON.stringify(results, null, 2));

const exactlyOnce = countedWashes === events.length && countedRevenue === events.length * AMOUNT;
console.log(exactlyOnce && failures === 0 && dlqDepth === 0 ? '\nPASS: every event counted exactly once, none lost.' : '\nFAIL: see the numbers above.');
process.exitCode = exactlyOnce && failures === 0 && dlqDepth === 0 ? 0 : 1;
