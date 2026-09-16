import type { QueueEnvelope } from '../src/domain/events';

export function washCompletedPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1001',
    locationId: 'miami-01',
    eventType: 'WASH_COMPLETED',
    timestamp: '2026-09-14T18:30:00Z',
    data: { washPackage: 'Premium', amount: 22.0, durationSeconds: 312 },
    ...overrides,
  };
}

export function heartbeatPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'hb-2001',
    locationId: 'miami-01',
    eventType: 'CONTROLLER_HEARTBEAT',
    timestamp: '2026-09-14T18:31:00Z',
    data: { controllerId: 'ctrl-a', firmwareVersion: '4.2.1', uptimeSeconds: 86_400 },
    ...overrides,
  };
}

export function envelopeFor(event: object): QueueEnvelope {
  return {
    correlationId: 'corr-test-0001',
    receivedAt: '2026-09-14T18:30:01.000Z',
    archiveKey: 'raw/date=2026-09-14/location=miami-01/evt-1001_corr-test-0001.json',
    event,
  } as QueueEnvelope;
}
