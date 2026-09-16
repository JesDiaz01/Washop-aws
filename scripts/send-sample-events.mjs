#!/usr/bin/env node
/**
 * Sends a realistic sequence of events to a deployed WashOps API, including a duplicate
 * delivery and two invalid events, then reads back the results.
 *
 * Usage: node scripts/send-sample-events.mjs <ApiBaseUrl> [locationId]
 */

const [baseUrl, locationId = 'miami-01'] = process.argv.slice(2);
if (!baseUrl) {
  console.error('Usage: node scripts/send-sample-events.mjs <ApiBaseUrl> [locationId]');
  process.exit(1);
}

const api = baseUrl.replace(/\/$/, '');
const run = Date.now().toString(36); // unique per run so re-runs aren't all treated as duplicates
const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

const washCompleted = {
  eventId: `evt-${run}-wash`,
  locationId,
  eventType: 'WASH_COMPLETED',
  timestamp: at(60),
  data: { washPackage: 'Premium', amount: 22.0, durationSeconds: 312 },
};

const steps = [
  {
    label: 'CONTROLLER_HEARTBEAT',
    body: { eventId: `hb-${run}`, locationId, eventType: 'CONTROLLER_HEARTBEAT', timestamp: at(0), data: { controllerId: 'ctrl-a', firmwareVersion: '4.2.1', uptimeSeconds: 86400 } },
  },
  {
    label: 'WASH_STARTED',
    body: { eventId: `evt-${run}-start`, locationId, eventType: 'WASH_STARTED', timestamp: at(372), data: { washPackage: 'Premium', bayId: 'tunnel-1' } },
  },
  { label: 'WASH_COMPLETED', body: washCompleted },
  { label: 'WASH_COMPLETED again (duplicate delivery, same eventId)', body: washCompleted },
  {
    label: 'PAYMENT_COMPLETED',
    body: { eventId: `evt-${run}-pay`, locationId, eventType: 'PAYMENT_COMPLETED', timestamp: at(380), data: { amount: 22.0, paymentMethod: 'CARD', transactionId: `txn-${run}` } },
  },
  {
    label: 'EQUIPMENT_FAULT',
    body: { eventId: `evt-${run}-fault`, locationId, eventType: 'EQUIPMENT_FAULT', timestamp: at(30), data: { equipmentId: 'dryer-2', faultCode: 'E-MOTOR-OVERTEMP', severity: 'HIGH' } },
  },
  {
    label: 'INVALID: negative amount + bad timestamp (expect 400)',
    body: { ...washCompleted, eventId: `evt-${run}-bad`, timestamp: 'yesterday', data: { ...washCompleted.data, amount: -5 } },
  },
  {
    label: 'INVALID: unsupported eventType (expect 400)',
    body: { ...washCompleted, eventId: `evt-${run}-unsupported`, eventType: 'CAR_TELEPORTED' },
  },
];

async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

console.log(`Sending events to ${api} (run ${run})\n`);
for (const step of steps) {
  const { status, body } = await call('POST', '/events', step.body);
  console.log(`POST /events  ${status}  ${step.label}`);
  console.log(`  ${JSON.stringify(body)}\n`);
}

console.log('Waiting 5s for asynchronous processing (SQS -> processor Lambda -> DynamoDB)...\n');
await new Promise((resolve) => setTimeout(resolve, 5000));

for (const path of [
  `/locations/${locationId}/summary`,
  `/events/${washCompleted.eventId}`,
  `/locations/${locationId}/events?limit=5`,
]) {
  const { status, body } = await call('GET', path);
  console.log(`GET ${path}  ${status}`);
  console.log(JSON.stringify(body, null, 2), '\n');
}
