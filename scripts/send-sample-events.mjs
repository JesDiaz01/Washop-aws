#!/usr/bin/env node
/**
 * Sends a realistic sequence of events to a deployed WashOps API, including a duplicate
 * delivery, two invalid events, a wrong controller clock, an event for the wrong site, and an
 * unauthenticated request, then reads back the results.
 *
 * Usage: node scripts/send-sample-events.mjs <ApiBaseUrl> [locationId]
 * locationId must be a site the credential is bound to (the demo credential: miami-01).
 *
 * Authenticates like a site controller (OAuth 2.0 client credentials). Set:
 *   WASHOPS_TOKEN_URL      stack output TokenUrl
 *   WASHOPS_CLIENT_ID      stack output SiteControllerClientId
 *   WASHOPS_CLIENT_SECRET  aws cognito-idp describe-user-pool-client --user-pool-id <UserPoolId>
 *                            --client-id <SiteControllerClientId> --query UserPoolClient.ClientSecret --output text
 */

const [baseUrl, locationId = 'miami-01'] = process.argv.slice(2);
const { WASHOPS_TOKEN_URL: tokenUrl, WASHOPS_CLIENT_ID: clientId, WASHOPS_CLIENT_SECRET: clientSecret } = process.env;
if (!baseUrl || !tokenUrl || !clientId || !clientSecret) {
  console.error('Usage: node scripts/send-sample-events.mjs <ApiBaseUrl> [locationId]');
  console.error('Requires WASHOPS_TOKEN_URL, WASHOPS_CLIENT_ID, and WASHOPS_CLIENT_SECRET (see the comment at the top).');
  process.exit(1);
}

const api = baseUrl.replace(/\/$/, '');
const run = Date.now().toString(36); // unique per run so re-runs aren't all treated as duplicates
const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

/** Client credentials grant: the controller trades its ID and secret for a short-lived access token. */
async function getAccessToken() {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    // washops/site.<locationId> binds the token to one site; ingest rejects events for any other.
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: `washops/events.write washops/events.read washops/site.${locationId}`,
    }),
  });
  if (!response.ok) {
    console.error(`Token request failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  const { access_token: accessToken, expires_in: expiresIn } = await response.json();
  console.log(`Got an access token from Cognito (valid ${expiresIn}s)\n`);
  return accessToken;
}

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
  {
    label: 'CLOCK 2 HOURS AHEAD (expect 202 with a warning; stored and flagged)',
    body: { ...washCompleted, eventId: `evt-${run}-clock`, timestamp: at(-7200) },
  },
  {
    label: 'WRONG SITE for this credential (expect 403)',
    body: { ...washCompleted, eventId: `evt-${run}-wrong-site`, locationId: 'other-site-01' },
  },
  {
    label: 'NO TOKEN (expect 401, rejected by API Gateway before any Lambda runs)',
    body: { ...washCompleted, eventId: `evt-${run}-anonymous` },
    anonymous: true,
  },
];

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

const token = await getAccessToken();

console.log(`Sending events to ${api} (run ${run})\n`);
for (const step of steps) {
  const { status, body } = await call('POST', '/events', { body: step.body, token: step.anonymous ? undefined : token });
  console.log(`POST /events  ${status}  ${step.label}`);
  console.log(`  ${JSON.stringify(body)}\n`);
}

console.log('Waiting 5s for asynchronous processing (SQS -> processor Lambda -> DynamoDB)...\n');
await new Promise((resolve) => setTimeout(resolve, 5000));

for (const path of [
  `/locations/${locationId}/summary`,
  `/events/${washCompleted.eventId}`,
  `/locations/${locationId}/events?limit=5`,
  '/locations',
]) {
  const { status, body } = await call('GET', path, { token });
  console.log(`GET ${path}  ${status}`);
  console.log(JSON.stringify(body, null, 2), '\n');
}
