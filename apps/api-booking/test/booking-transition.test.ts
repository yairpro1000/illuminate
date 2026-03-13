import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOKING_POLICY,
  currentStatusForEvent,
  getEffectsForEvent,
  shouldReserveSlotForTransition,
} from '../src/domain/booking-effect-policy.js';

describe('booking effect policy', () => {
  it('maps pay-now submission to checkout creation and pending payment verification', () => {
    const eventAtIso = '2026-03-10T10:00:00.000Z';
    const effects = getEffectsForEvent({
      booking: {
        id: 'b1',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING',
        booking_type: 'PAY_NOW',
      },
      eventType: 'BOOKING_FORM_SUBMITTED',
      eventAtIso,
      paymentStatus: 'PENDING',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'CREATE_STRIPE_CHECKOUT',
      'VERIFY_STRIPE_PAYMENT',
    ]);
    expect(effects.map((effect) => effect.entity)).toEqual(['PAYMENT', 'PAYMENT']);
    expect(effects[1]?.expires_at).toBe(
      new Date(
        new Date(eventAtIso).getTime() + DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes * 60_000,
      ).toISOString(),
    );
  });

  it('maps non-paid submission to confirmation request plus verification checkpoint', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b2',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING',
        booking_type: 'PAY_LATER',
      },
      eventType: 'BOOKING_FORM_SUBMITTED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'SEND_BOOKING_CONFIRMATION_REQUEST',
      'VERIFY_EMAIL_CONFIRMATION',
    ]);
    expect(effects.map((effect) => effect.entity)).toEqual(['EMAIL', 'SYSTEM']);
  });

  it('maps payment settled to confirmed booking state and downstream work', () => {
    const next = currentStatusForEvent('PAYMENT_SETTLED', 'PENDING', 'PAY_NOW', 'SUCCEEDED');
    expect(next).toBe('CONFIRMED');

    const effects = getEffectsForEvent({
      booking: {
        id: 'b3',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING',
        booking_type: 'PAY_NOW',
      },
      eventType: 'PAYMENT_SETTLED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentStatus: 'SUCCEEDED',
    });
    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'RESERVE_CALENDAR_SLOT',
      'SEND_BOOKING_CONFIRMATION',
    ]);
  });

  it('reserves only on finalizing transitions for 1:1 bookings', () => {
    expect(shouldReserveSlotForTransition({
      booking: { event_id: null, booking_type: 'PAY_NOW' },
      eventType: 'BOOKING_FORM_SUBMITTED',
      previousStatus: 'PENDING',
      nextStatus: 'PENDING',
    })).toBe(false);

    expect(shouldReserveSlotForTransition({
      booking: { event_id: null, booking_type: 'PAY_NOW' },
      eventType: 'PAYMENT_SETTLED',
      previousStatus: 'PENDING',
      nextStatus: 'CONFIRMED',
    })).toBe(true);

    expect(shouldReserveSlotForTransition({
      booking: { event_id: 'evt_1', booking_type: 'FREE' },
      eventType: 'PAYMENT_SETTLED',
      previousStatus: 'PENDING',
      nextStatus: 'CONFIRMED',
    })).toBe(false);
  });
});
