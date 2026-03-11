import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOKING_POLICY,
  currentStatusForEvent,
  getEffectsForEvent,
  shouldReserveSlotForTransition,
} from '../src/domain/booking-effect-policy.js';

describe('booking effect policy', () => {
  it('maps pay-now submission to checkout + payment-link + expire intents', () => {
    const eventAtIso = '2026-03-10T10:00:00.000Z';
    const effects = getEffectsForEvent({
      booking: {
        id: 'b1',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING_CONFIRMATION',
      },
      eventType: 'BOOKING_FORM_SUBMITTED_PAY_NOW',
      eventAtIso,
      paymentMode: 'pay_now',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'create_stripe_checkout',
      'send_payment_link',
      'expire_booking',
    ]);
    expect(effects.map((effect) => effect.entity)).toEqual([
      'payment',
      'email',
      'system',
    ]);

    const eventAtMs = new Date(eventAtIso).getTime();
    const reminderIso = new Date(
      eventAtMs + DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes * 60_000,
    ).toISOString();
    const expiryIso = new Date(
      eventAtMs + (DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes + DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes) * 60_000,
    ).toISOString();
    expect(effects[0]?.expires_at).toBeNull();
    expect(effects[1]?.expires_at).toBe(reminderIso);
    expect(effects[2]?.expires_at).toBe(expiryIso);
  });

  it('maps slot-confirmed pay-later to date reminder + confirmation + payment reminder', () => {
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
      'send_booking_confirmation',
      'send_payment_reminder',
    ]);
    expect(effects[2]?.expires_at).toBe('2026-03-19T10:00:00.000Z');
  });

  it('maps payment settled to PAID cached status', () => {
    const next = currentStatusForEvent('PAYMENT_SETTLED', 'PENDING_CONFIRMATION', 'pay_now');
    expect(next).toBe('PAID');
  });

  it('maps slot-confirmed pay-now to date reminder + booking confirmation', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b3',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PAID',
      },
      eventType: 'SLOT_CONFIRMED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentMode: 'pay_now',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'send_date_reminder',
      'send_booking_confirmation',
    ]);
  });

  it('maps event email-confirmed to immediate booking confirmation email', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b4',
        event_id: 'evt_1',
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'PENDING_CONFIRMATION',
      },
      eventType: 'EMAIL_CONFIRMED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentMode: 'free',
    });

    expect(effects.map((effect) => effect.effect_intent)).toEqual([
      'send_booking_confirmation',
    ]);
  });

  it('maps close-booking intent to system entity', () => {
    const effects = getEffectsForEvent({
      booking: {
        id: 'b5',
        event_id: null,
        starts_at: '2026-03-20T10:00:00.000Z',
        current_status: 'CANCELED',
      },
      eventType: 'BOOKING_CLOSED',
      eventAtIso: '2026-03-10T10:00:00.000Z',
      paymentMode: 'pay_later',
    });

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      effect_intent: 'close_booking',
      entity: 'system',
    });
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
