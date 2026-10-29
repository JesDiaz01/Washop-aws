import { beforeAll, describe, expect, it } from 'vitest';
import { callApi, eventually, getSiteToken, loadStackConfig, type SiteToken, type StackConfig } from './stack';

/**
 * End-to-end tests against a deployed stack: real API Gateway, Cognito, Lambda, SQS, and DynamoDB.
 * They write real data, so run them against dev (the default), never prod.
 *
 *   npm run test:integration                         # washops-dev, via the AWS CLI
 *   WASHOPS_STACK=my-stack npm run test:integration  # another stack
 */

let config: StackConfig;
let site: SiteToken;
const run = Date.now().toString(36); // unique per run, so reruns aren't treated as duplicates
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const washCompleted = (eventId: string, overrides: Record<string, unknown> = {}) => ({
  eventId,
  locationId: site.locationId,
  eventType: 'WASH_COMPLETED',
  timestamp: iso(-5_000),
  data: { washPackage: 'Integration', amount: 12.5, durationSeconds: 240 },
  ...overrides,
});

const post = (body: unknown, { anonymous = false } = {}) =>
  callApi(config, 'POST', '/events', { token: anonymous ? undefined : site.accessToken, body });
const get = (path: string) => callApi(config, 'GET', path, { token: site.accessToken });

/** Waits until the processor has recorded the event, then returns it as the API shows it. */
const processedEvent = (eventId: string) =>
  eventually(`event ${eventId} to be processed`, async () => {
    const response = await get(`/events/${eventId}`);
    return response.status === 200 ? response.body : undefined;
  });

const completedWashes = async () => {
  const response = await get(`/locations/${site.locationId}/summary`);
  return response.status === 200 ? (response.body.completedWashes as number) : 0;
};

beforeAll(async () => {
  config = loadStackConfig();
  site = await getSiteToken(config);
});

describe(`deployed API (${process.env.WASHOPS_STACK ?? 'washops-dev'})`, () => {
  it('rejects a request without a token before any code runs', async () => {
    const response = await post(washCompleted(`it-${run}-anon`), { anonymous: true });

    expect(response.status).toBe(401);
  });

  it('rejects an invalid event with field-level errors', async () => {
    const response = await post(washCompleted(`it-${run}-bad`, { timestamp: 'yesterday' }));

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'timestamp' })]));
  });

  it("rejects an event for a site this credential isn't bound to", async () => {
    const response = await post(washCompleted(`it-${run}-other`, { locationId: `${site.locationId}-not-mine` }));

    expect(response.status).toBe(403);
  });

  it('accepts, archives, and processes an event end to end', async () => {
    const eventId = `it-${run}-wash`;

    const accepted = await post(washCompleted(eventId));
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ message: 'Event accepted', eventId });
    expect(accepted.body).not.toHaveProperty('warnings');

    const event = await processedEvent(eventId);
    expect(event).toMatchObject({
      eventId,
      locationId: site.locationId,
      eventType: 'WASH_COMPLETED',
      correlationId: accepted.body.correlationId,
      data: { washPackage: 'Integration', amount: 12.5, durationSeconds: 240 },
    });
    expect(event.archiveKey).toMatch(new RegExp(`^raw/date=\\d{4}-\\d{2}-\\d{2}/location=${site.locationId}/${eventId}_`));
  });

  it('counts a duplicate delivery once', async () => {
    const eventId = `it-${run}-dup`;
    const before = await completedWashes();

    expect((await post(washCompleted(eventId))).status).toBe(202);
    expect((await post(washCompleted(eventId))).status).toBe(202); // the controller retried
    await processedEvent(eventId);

    // Give the second delivery time to be processed too, then check it didn't count.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await completedWashes()).toBe(before + 1);
  });

  it('accepts an event from a wrong clock, warns, and flags it', async () => {
    const eventId = `it-${run}-future`;

    const accepted = await post(washCompleted(eventId, { timestamp: iso(2 * 3_600_000) }));
    expect(accepted.status).toBe(202);
    expect(accepted.body.warnings).toEqual([expect.stringContaining('ahead of server time')]);

    const event = await processedEvent(eventId);
    expect(event.clockSkewSeconds).toBeGreaterThan(7_000);
  });

  it("measures the controller's clock from heartbeats, using server time for liveness", async () => {
    const heartbeat = (eventId: string, timestamp: string) => ({
      eventId,
      locationId: site.locationId,
      eventType: 'CONTROLLER_HEARTBEAT',
      timestamp,
      data: { controllerId: 'integration-test' },
    });

    // An hour behind: the site must still look alive, with the clock error recorded.
    expect((await post(heartbeat(`it-${run}-hb-slow`, iso(-3_600_000)))).status).toBe(202);
    const skewed = await eventually('the slow heartbeat to be recorded', async () => {
      const { body } = await get(`/locations/${site.locationId}/summary`);
      return (body.controllerClockSkewSeconds as number) < -3_000 ? body : undefined;
    });
    expect(Date.now() - Date.parse(skewed.lastHeartbeat as string)).toBeLessThan(5 * 60_000);

    // Then a correct heartbeat, which also leaves the dev site looking healthy afterwards.
    expect((await post(heartbeat(`it-${run}-hb-ok`, iso(0)))).status).toBe(202);
    await eventually('the clock error to clear', async () => {
      const { body } = await get(`/locations/${site.locationId}/summary`);
      return Math.abs(body.controllerClockSkewSeconds as number) < 300 ? body : undefined;
    });
  });

  it('lists the site in GET /locations', async () => {
    const response = await get('/locations');

    expect(response.status).toBe(200);
    expect(response.body.locations).toEqual(
      expect.arrayContaining([expect.objectContaining({ locationId: site.locationId })]),
    );
  });
});
