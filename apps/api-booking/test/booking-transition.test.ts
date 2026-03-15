import { describe, expect, it } from 'vitest';
import {
  currentStatusForEvent,
  getEffectsForEvent,
  getBookingPolicyConfig,
  shouldReserveSlotForTransition,
} from '../src/domain/booking-effect-policy.js';
import { MockRepository } from '../src/providers/repository/mock.js';

describe('booking effect policy', () => {
  it('maps pay-now submission to checkout creation and pending payment verification', async () => {
    const eventAtIso = '2026-03-10T10:00:00.000Z';
    const policy = await getBookingPolicyConfig(new MockRepository());
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
    }, policy);

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'CREATE_STRIPE_CHECKOUT',
      'VERIFY_STRIPE_PAYMENT',
    ]);
    expect(effects.map((effect) => effect.entity)).toEqual(['PAYMENT', 'PAYMENT']);
    expect(effects[1]?.expires_at).toBe(
      new Date(
        new Date(eventAtIso).getTime() + policy.payNowCheckoutWindowMinutes * 60_000,
      ).toISOString(),
    );
  });

  it('maps pay-later submission to confirmation request and email verification', async () => {
    const policy = await getBookingPolicyConfig(new MockRepository());
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
    }, policy);

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'SEND_BOOKING_CONFIRMATION_REQUEST',
      'VERIFY_EMAIL_CONFIRMATION',
    ]);
  });

  it('maps payment settled to confirmed booking state and downstream work', async () => {
    const next = currentStatusForEvent('PAYMENT_SETTLED', 'PENDING', 'PAY_NOW', 'SUCCEEDED');
    expect(next).toBe('CONFIRMED');

    const policy = await getBookingPolicyConfig(new MockRepository());
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
    }, policy);
    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'RESERVE_CALENDAR_SLOT',
      'SEND_BOOKING_CONFIRMATION',
    ]);
  });

  it('does not re-confirm an already confirmed pay-later booking on later payment settlement', async () => {
    const policy = await getBookingPolicyConfig(new MockRepository());
    const effects = getEffectsForEvent({
      booking: {
        id: 'b4',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'CONFIRMED',
        booking_type: 'PAY_LATER',
      },
      eventType: 'PAYMENT_SETTLED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentStatus: 'SUCCEEDED',
    }, policy);

    expect(effects).toEqual([]);
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
