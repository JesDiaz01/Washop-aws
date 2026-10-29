import { describe, expect, it } from 'vitest';
import { describeSkew, isClockSuspect } from '../src/domain/clock';
import { connectivityChangeFor } from '../src/domain/connectivity';
import { toValidationIssues, washEventSchema } from '../src/domain/events';
import { canSendFor } from '../src/domain/siteAccess';
import { counterIncrementsFor, toCents } from '../src/domain/summary';
import { heartbeatPayload, washCompletedPayload } from './fixtures';

describe('washEventSchema', () => {
  it('accepts a valid WASH_COMPLETED event', () => {
    const result = washEventSchema.safeParse(washCompletedPayload());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ eventId: 'evt-1001', eventType: 'WASH_COMPLETED' });
  });

  it('normalizes timestamps with offsets to UTC so they sort correctly', () => {
    const result = washEventSchema.parse(washCompletedPayload({ timestamp: '2026-09-14T14:30:00-04:00' }));

    expect(result.timestamp).toBe('2026-09-14T18:30:00.000Z');
  });

  it('strips unknown fields instead of rejecting them (forward compatible)', () => {
    const result = washEventSchema.parse(washCompletedPayload({ firmwareExtra: 'x' }));

    expect(result).not.toHaveProperty('firmwareExtra');
  });

  it.each([
    ['missing eventId', { eventId: undefined }, 'eventId'],
    ['unsafe characters in eventId', { eventId: 'evt/../1' }, 'eventId'],
    ['non-ISO timestamp', { timestamp: '14/09/2026' }, 'timestamp'],
    [
      'negative amount',
      { data: { washPackage: 'Basic', amount: -5, durationSeconds: 100 } },
      'data.amount',
    ],
    [
      'sub-cent amount',
      { data: { washPackage: 'Basic', amount: 10.005, durationSeconds: 100 } },
      'data.amount',
    ],
  ])('rejects %s', (_label, overrides, expectedPath) => {
    const result = washEventSchema.safeParse(washCompletedPayload(overrides));

    expect(result.success).toBe(false);
    expect(toValidationIssues(result.error!).map((i) => i.path)).toContain(expectedPath);
  });

  it('rejects unsupported event types with a helpful message', () => {
    const result = washEventSchema.safeParse(washCompletedPayload({ eventType: 'CAR_TELEPORTED' }));

    expect(result.success).toBe(false);
    const issues = toValidationIssues(result.error!);
    expect(issues[0]?.message).toContain('eventType must be one of');
    expect(issues[0]?.message).toContain('WASH_COMPLETED');
  });
});

describe('counterIncrementsFor', () => {
  it('counts a completed wash and its revenue in integer cents', () => {
    const event = washEventSchema.parse(
      washCompletedPayload({ data: { washPackage: 'Premium', amount: 19.99, durationSeconds: 300 } }),
    );

    expect(counterIncrementsFor(event)).toEqual({ completedWashes: 1, washRevenueCents: 1999 });
  });

  it('does not increment counters for heartbeats', () => {
    expect(counterIncrementsFor(washEventSchema.parse(heartbeatPayload()))).toEqual({});
  });

  it('avoids floating point drift when converting to cents', () => {
    expect(19.99 * 100).not.toBe(1999); // the bug we're guarding against
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1) + toCents(0.2)).toBe(30);
  });
});

describe('connectivityChangeFor', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const site = (lastHeartbeat: string | undefined, connectivity?: 'ONLINE' | 'OFFLINE') => ({
    locationId: 'miami-01',
    lastHeartbeat,
    connectivity,
  });

  it.each([
    ['silent past the threshold', site('2026-09-14T11:49:00Z'), 'OFFLINE'],
    ['silent exactly at the threshold', site('2026-09-14T11:50:00Z'), undefined],
    ['heartbeating normally', site('2026-09-14T11:59:00Z'), undefined],
    ['still offline', site('2026-09-14T09:00:00Z', 'OFFLINE'), undefined],
    ['offline but heartbeating again', site('2026-09-14T11:59:00Z', 'OFFLINE'), 'ONLINE'],
    ['online again and silent again', site('2026-09-14T11:00:00Z', 'ONLINE'), 'OFFLINE'],
    ['never sent a heartbeat', site(undefined), undefined],
  ])('%s', (_label, input, expected) => {
    expect(connectivityChangeFor(input, now, 10)).toBe(expected);
  });
});

describe('isClockSuspect', () => {
  const receivedAt = '2026-09-14T12:00:00.000Z';
  const wash = (timestamp: string) => ({ eventType: 'WASH_COMPLETED' as const, timestamp });
  const heartbeat = (timestamp: string) => ({ eventType: 'CONTROLLER_HEARTBEAT' as const, timestamp });

  it.each([
    ['a wash a few seconds old', wash('2026-09-14T11:59:50Z'), false],
    ['a wash from a 2-day backlog after an outage', wash('2026-09-12T12:00:00Z'), false],
    ['a wash 10 minutes in the future', wash('2026-09-14T12:10:00Z'), true],
    ['a wash from 2019', wash('2019-01-01T00:00:00Z'), true],
    ['a heartbeat 2 minutes behind (network delay)', heartbeat('2026-09-14T11:58:00Z'), false],
    ['a heartbeat an hour behind (clock wrong)', heartbeat('2026-09-14T11:00:00Z'), true],
    ['a heartbeat 10 minutes ahead', heartbeat('2026-09-14T12:10:00Z'), true],
  ])('%s', (_label, event, expected) => {
    expect(isClockSuspect(event, receivedAt)).toBe(expected);
  });

  it('describes skew in words people can act on', () => {
    expect(describeSkew(600)).toBe('10 min ahead of');
    expect(describeSkew(-7_200)).toBe('2 h behind');
    expect(describeSkew(-3 * 86_400)).toBe('3 days behind');
  });
});

describe('canSendFor', () => {
  const scopes = ['washops/events.write', 'washops/site.miami-01'];

  it('allows only the sites named in the token', () => {
    expect(canSendFor(scopes, 'miami-01')).toBe(true);
    expect(canSendFor(scopes, 'tampa-02')).toBe(false);
    expect(canSendFor(scopes, 'miami-0')).toBe(false); // no prefix tricks
  });
});
