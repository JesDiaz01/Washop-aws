import { describe, expect, it } from 'vitest';
import { toValidationIssues, washEventSchema } from '../src/domain/events';
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
