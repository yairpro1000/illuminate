import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleGetSlots } from '../src/handlers/slots.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import {
  applyBookingPolicyOverridesForTests,
  resetBookingPolicyForTests,
} from '../src/domain/booking-effect-policy.js';
import {
  ensureEventPublicBookable,
  evaluateManageBookingPolicy,
} from '../src/services/booking-service.js';
import {
  compute24hReminderTime,
  computePaymentDueReminderTime,
} from '../src/services/reminder-service.js';
import { makeCtx } from './admin-helpers.js';

const seededEvents = [...mockState.events.values()].map((event) => ({ ...event }));

function resetMockState(): void {
  mockState.clients.clear();
  mockState.bookings.clear();
  mockState.events.clear();
  for (const event of seededEvents) {
    mockState.events.set(event.id, { ...event });
  }
  mockState.eventLateAccessLinks.clear();
  mockState.eventReminderSubscriptions.clear();
  mockState.contactMessages.clear();
  mockState.payments.clear();
  mockState.sentEmails.length = 0;
  mockState.bookingEvents.length = 0;
  mockState.sideEffects.length = 0;
  mockState.sideEffectAttempts.length = 0;
}

describe('booking policy config', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBookingPolicyForTests();
    resetMockState();
  });

  it('uses configured reminder timing values from the shared policy config', () => {
    applyBookingPolicyOverridesForTests({
      paymentDueReminderLeadHours: 4,
      paymentDueReminderSleepHoursStart: 21,
      paymentDueReminderSleepHoursEnd: 7,
      paymentDueReminderFallbackHourPreviousDay: 17,
      paymentDueReminderFallbackHourNextMorning: 9,
      eventReminderLeadHours: 12,
    });

    const paymentDueAt = new Date('2026-03-15T08:00:00.000Z');
    const now = new Date('2026-03-13T10:00:00.000Z');
    expect(
      computePaymentDueReminderTime(paymentDueAt, 'Europe/Zurich', now).toISOString(),
    ).toBe('2026-03-14T16:00:00.000Z');

    expect(
      compute24hReminderTime(
        new Date('2026-03-15T18:00:00.000Z'),
        new Date('2026-03-15T01:00:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-03-15T06:00:00.000Z');
  });

  it('uses configured stale-processing timeout minutes when resetting stuck side effects', async () => {
    applyBookingPolicyOverridesForTests({
      sideEffectProcessingTimeoutMinutes: 3,
    });
    resetMockState();

    mockState.sideEffects.push(
      {
        id: 'effect-old',
        booking_id: 'booking-1',
        booking_event_id: 'event-1',
        entity: 'SYSTEM',
        effect_intent: 'VERIFY_EMAIL_CONFIRMATION',
        status: 'PROCESSING',
        expires_at: null,
        max_attempts: 5,
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T09:56:00.000Z',
      },
      {
        id: 'effect-fresh',
        booking_id: 'booking-2',
        booking_event_id: 'event-2',
        entity: 'SYSTEM',
        effect_intent: 'VERIFY_EMAIL_CONFIRMATION',
        status: 'PROCESSING',
        expires_at: null,
        max_attempts: 5,
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T09:58:30.000Z',
      },
    );

    const repo = new MockRepository();
    const resetCount = await repo.markStaleProcessingSideEffectsAsPending('2026-03-01T10:00:00.000Z');

    expect(resetCount).toBe(1);
    expect(mockState.sideEffects.find((effect) => effect.id === 'effect-old')?.status).toBe('PENDING');
    expect(mockState.sideEffects.find((effect) => effect.id === 'effect-fresh')?.status).toBe('PROCESSING');
  });

  it('uses configured self-service and public event cutoff windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    applyBookingPolicyOverridesForTests({
      selfServiceLockWindowHours: 36,
      publicEventCutoffAfterStartMinutes: 90,
    });

    expect(
      evaluateManageBookingPolicy('2026-03-02T18:00:00.000Z').canSelfServeChange,
    ).toBe(false);

    await expect(ensureEventPublicBookable({
      status: 'published',
      starts_at: '2026-03-01T11:00:00.000Z',
    } as any)).resolves.toBeUndefined();
  });

  it('uses configured slot lead time hours when generating slots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    applyBookingPolicyOverridesForTests({
      slotLeadTimeHours: 48,
    });
    const ctx = makeCtx({
      providers: {
        calendar: { getBusyTimes: async () => [] },
        repository: { getHeldSlots: async () => [] },
      } as any,
    });

    const res = await handleGetSlots(
      new Request('https://api.local/api/slots?from=2026-03-02&to=2026-03-02&tz=Europe/Zurich&type=intro'),
      ctx,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.slots).toEqual([]);
  });
});
