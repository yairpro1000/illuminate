import { describe, expect, it } from 'vitest';
import { currentStatusForEvent, getEffectsForEvent, shouldReserveSlotForTransition } from '../src/domain/booking-effect-policy.js';

describe('booking effect policy', () => {
  it('maps pay-now submission to checkout + expire intents', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b1',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING_CONFIRMATION',
      },
      eventType: 'BOOKING_FORM_SUBMITTED_PAY_NOW',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentMode: 'pay_now',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'create_stripe_checkout',
      'expire_booking',
    ]);

    expect(effects[0]?.expires_at).toBe('2026-03-10T10:45:00.000Z');
  });

  it('maps slot-confirmed pay-later to date reminder + payment reminder', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b2',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'SLOT_CONFIRMED',
      },
      eventType: 'SLOT_CONFIRMED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentMode: 'pay_later',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'send_date_reminder',
      'send_payment_reminder',
    ]);
    expect(effects[1]?.expires_at).toBe('2026-03-19T10:00:00.000Z');
  });

  it('maps payment settled to PAID cached status', () => {
    const next = currentStatusForEvent('PAYMENT_SETTLED', 'PENDING_CONFIRMATION', 'pay_now');
    expect(next).toBe('PAID');
  });

  it('reserves on finalized transitions, not on submission', () => {
    expect(shouldReserveSlotForTransition({
      booking: { event_id: null },
      eventType: 'BOOKING_FORM_SUBMITTED_PAY_NOW',
      previousStatus: 'PENDING_CONFIRMATION',
      nextStatus: 'PENDING_CONFIRMATION',
    })).toBe(false);

    expect(shouldReserveSlotForTransition({
      booking: { event_id: null },
      eventType: 'EMAIL_CONFIRMED',
      previousStatus: 'PENDING_CONFIRMATION',
      nextStatus: 'SLOT_CONFIRMED',
    })).toBe(true);

    expect(shouldReserveSlotForTransition({
      booking: { event_id: null },
      eventType: 'PAYMENT_SETTLED',
      previousStatus: 'PENDING_CONFIRMATION',
      nextStatus: 'PAID',
    })).toBe(true);

    expect(shouldReserveSlotForTransition({
      booking: { event_id: 'evt_1' },
      eventType: 'EMAIL_CONFIRMED',
      previousStatus: 'PENDING_CONFIRMATION',
      nextStatus: 'SLOT_CONFIRMED',
    })).toBe(false);
  });
});
