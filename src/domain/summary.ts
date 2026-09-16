import type { WashEvent } from './events';

/**
 * Counters on the LocationSummary item. Each event type increments some of them.
 * Money is stored as integer cents to avoid floating point drift.
 *
 * Revenue rule: wash revenue is recognized on WASH_COMPLETED. PAYMENT_COMPLETED is tracked
 * separately (count + volume) so the two are never double-counted.
 */
export interface CounterIncrements {
  washesStarted?: number;
  completedWashes?: number;
  washRevenueCents?: number;
  paymentsCompleted?: number;
  paymentVolumeCents?: number;
  equipmentFaults?: number;
}

export function toCents(amount: number): number {
  // 19.99 * 100 === 1998.9999999999998 in IEEE-754, so rounding is required.
  return Math.round(amount * 100);
}

export function counterIncrementsFor(event: WashEvent): CounterIncrements {
  switch (event.eventType) {
    case 'WASH_STARTED':
      return { washesStarted: 1 };
    case 'WASH_COMPLETED':
      return { completedWashes: 1, washRevenueCents: toCents(event.data.amount) };
    case 'PAYMENT_COMPLETED':
      return { paymentsCompleted: 1, paymentVolumeCents: toCents(event.data.amount) };
    case 'EQUIPMENT_FAULT':
      return { equipmentFaults: 1 };
    case 'CONTROLLER_HEARTBEAT':
      // Heartbeats don't increment counters; they only move lastHeartbeat forward.
      return {};
    default: {
      // Compile-time guarantee that every event type is handled.
      const unhandled: never = event;
      throw new Error(`Unhandled event type: ${JSON.stringify(unhandled)}`);
    }
  }
}
