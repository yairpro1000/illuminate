import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayLaterBooking, confirmBookingEmail } from '../src/services/booking-service.js';
import {
  loadBookingReadModel,
  loadBookingWithLatestPayment,
  loadBookingWithLatestPaymentAndSelectedEvent,
} from '../src/services/booking-read-model.js';
import { mockState } from '../src/providers/mock-state.js';
import { makeCtx } from './admin-helpers.js';

const seededEvents = [...mockState.events.values()].map((event) => ({ ...event }));

function resetMockState() {
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

describe('booking read model', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('loads the booking payment selected event side effects and attempts from one shared read owner', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue({
            eventId: 'g-read-model',
            meetingProvider: 'google_meet',
            meetingLink: 'https://meet.google.com/read-model',
          }),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: {
          createCheckoutSession: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm-request' }),
          sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-confirmed' }),
          sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-payment-due' }),
        },
      } as any,
    });

    const created = await createPayLaterBooking({
      slotStart: '2026-03-29T10:00:00.000Z',
      slotEnd: '2026-03-29T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Read Model',
      clientEmail: 'read-model@example.test',
      clientPhone: '+41790000021',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx as any);
    const submission = mockState.bookingEvents.find((event) =>
      event.booking_id === created.bookingId && event.event_type === 'BOOKING_FORM_SUBMITTED',
    );

    await confirmBookingEmail(String(submission?.payload?.['confirm_token'] ?? ''), ctx as any);

    const repository = ctx.providers.repository as any;
    const listSideEffectsForEventsSpy = vi.spyOn(repository, 'listBookingSideEffectsForEvents');
    const listAttemptsForSideEffectsSpy = vi.spyOn(repository, 'listBookingSideEffectAttemptsForSideEffects');

    const paymentSnapshot = await loadBookingWithLatestPayment({
      bookingId: created.bookingId,
    }, ctx as any);
    const eventSnapshot = await loadBookingWithLatestPaymentAndSelectedEvent({
      bookingId: created.bookingId,
      event: { mode: 'latest_of_type', eventType: 'BOOKING_FORM_SUBMITTED' },
    }, ctx as any);

    const readModel = await loadBookingReadModel({
      bookingId: created.bookingId,
      include: {
        payment: 'latest',
        event: { mode: 'latest_of_type', eventType: 'BOOKING_FORM_SUBMITTED' },
        sideEffects: { mode: 'selected_event', attempts: 'all' },
        apiLogs: 'all_related',
        exceptionLogs: 'all_related',
      },
    }, ctx as any);

    expect(paymentSnapshot.payment?.status).toBe('PENDING');
    expect(eventSnapshot.selectedEvent?.event_type).toBe('BOOKING_FORM_SUBMITTED');
    expect(readModel.booking.id).toBe(created.bookingId);
    expect(readModel.payment?.status).toBe('PENDING');
    expect(readModel.selectedEvent?.event_type).toBe('BOOKING_FORM_SUBMITTED');
    expect(readModel.sideEffects.map((effect) => effect.effect_intent)).toEqual(expect.arrayContaining([
      'VERIFY_EMAIL_CONFIRMATION',
      'SEND_BOOKING_CONFIRMATION',
    ]));
    expect(readModel.sideEffects.find((effect) => effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION')).toEqual(
      expect.objectContaining({
        status: 'SUCCESS',
        latestAttempt: expect.objectContaining({
          status: 'SUCCESS',
        }),
        attempts: expect.arrayContaining([
          expect.objectContaining({
            status: 'SUCCESS',
          }),
        ]),
      }),
    );
    expect(readModel.apiLogs).toEqual([]);
    expect(readModel.exceptionLogs).toEqual([]);
    expect(listSideEffectsForEventsSpy).toHaveBeenCalledOnce();
    expect(listAttemptsForSideEffectsSpy).toHaveBeenCalledOnce();
  });
});
