import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { confirmBookingEmail, createEventBooking, createPayLaterBooking } from '../src/services/booking-service.js';
import { mockState } from '../src/providers/mock-state.js';
import { makeCtx } from './admin-helpers.js';

describe('Manage booking token diagnostics', () => {
  it('returns 400 when token is missing and logs explicit deny reason', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue({
            eventId: 'g-manage-flow',
            meetingProvider: 'google_meet',
            meetingLink: 'https://meet.google.com/manage-flow',
          }),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: {
          createCheckoutSession: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
          sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-booking-confirmed' }),
          sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
        },
      } as any,
    });
    const req = new Request('https://api.local/api/bookings/manage', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'token is required',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_token_gate_decision',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_token',
        deny_reason: 'token_missing',
      }),
    }));
  });

  it('returns 400 for malformed edited token instead of INTERNAL_ERROR and logs diagnostics', async () => {
    const repo = {
      getBookingById: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository: repo } as any });
    const req = new Request('https://api.local/api/bookings/manage?token=m1.not-a-uuid', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Invalid manage token',
      request_id: 'req-1',
    });
    expect(repo.getBookingById).not.toHaveBeenCalled();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_token_gate_decision',
      context: expect.objectContaining({
        branch_taken: 'resolve_booking_by_manage_token',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_info_failed',
      context: expect.objectContaining({
        status_code: 400,
        error_code: 'BAD_REQUEST',
        branch_taken: 'handled_api_error',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_route_execution_failed',
      context: expect.objectContaining({
        status_code: 400,
        branch_taken: 'handled_api_error',
      }),
    }));
  });

  it('preserves CORS headers on malformed-token errors through router handling', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const req = new Request('https://api.local/api/bookings/manage?token=m1.invalid-token', {
      method: 'GET',
      headers: { Origin: 'https://letsilluminate.co' },
    });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Invalid manage token',
      request_id: 'req-1',
    });
  });

  it('returns continue-payment actions for confirmed unpaid pay-later bookings', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue({
            eventId: 'g-manage-flow',
            meetingProvider: 'google_meet',
            meetingLink: 'https://meet.google.com/manage-flow',
          }),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: {
          createCheckoutSession: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
          sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-booking-confirmed' }),
          sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
        },
      } as any,
    });
    const created = await createPayLaterBooking({
      slotStart: '2026-03-20T10:00:00.000Z',
      slotEnd: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Manage Flow',
      clientEmail: 'manage-flow@example.com',
      clientPhone: '+41000000061',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx as any);
    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    await confirmBookingEmail(String(submission?.payload?.confirm_token ?? ''), ctx as any);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/manage?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      payment_status: 'PENDING',
      actions: expect.objectContaining({
        can_complete_payment: true,
        continue_payment_url: expect.stringContaining(`/continue-payment.html?token=m1.${created.bookingId}`),
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_actions_gate_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        can_complete_payment: true,
        has_continue_payment_url: true,
      }),
    }));
  });

  it('returns booking-event status snapshots for tokenized polling clients', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue({
            eventId: 'g-event-status',
            meetingProvider: 'google_meet',
            meetingLink: 'https://meet.google.com/event-status',
          }),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: {
          createCheckoutSession: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
          sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-booking-confirmed' }),
          sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
        },
      } as any,
    });
    const created = await createPayLaterBooking({
      slotStart: '2026-03-21T10:00:00.000Z',
      slotEnd: '2026-03-21T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Event Status',
      clientEmail: 'event-status@example.com',
      clientPhone: '+41000000062',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx as any);
    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/event-status?booking_event_id=${submission?.id}&token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_event_id: submission?.id,
      booking_event_type: 'BOOKING_FORM_SUBMITTED',
      booking_id: created.bookingId,
      booking_status: 'PENDING',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_event_status_request_completed',
      context: expect.objectContaining({
        booking_event_id: submission?.id,
        booking_id: created.bookingId,
      }),
    }));
  });

  it('includes pay-at-event payment method details on event manage payloads', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: { verify: vi.fn().mockResolvedValue(undefined) },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue(undefined),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: { createCheckoutSession: vi.fn() },
        email: {
          sendEventConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-event-confirm' }),
          sendEventConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-event-booking-confirmed' }),
        },
      } as any,
    });
    const paidEvent = [...mockState.events.values()].find((event) => event.is_paid)!;
    const created = await createEventBooking({
      event: paidEvent,
      paymentMode: 'pay_at_event',
      firstName: 'Manage',
      lastName: 'Event',
      email: 'manage-event@example.com',
      phone: null,
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx as any);
    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    await confirmBookingEmail(String(submission?.payload?.confirm_token ?? ''), ctx as any);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/manage?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      payment_status: 'CASH_OK',
      payment_method: 'pay_at_event',
      payment_method_label: 'Pay at the event',
      payment_method_message: 'No online payment is required now. Your place will be confirmed after email confirmation.',
      actions: expect.objectContaining({
        can_complete_payment: true,
      }),
    }));
    expect(ctx.providers.email.sendEventConfirmation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(String),
      null,
      expect.stringContaining('/continue-payment.html?token='),
      expect.any(String),
      expect.objectContaining({
        paymentMethod: 'pay_at_event',
        paymentMethodLabel: 'Pay at the event',
      }),
    );
  });

  it('returns latest-of-type booking-event snapshots for tokenized polling clients', async () => {
    const ctx = makeCtx({
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn().mockResolvedValue({
            eventId: 'g-event-status-latest',
            meetingProvider: 'google_meet',
            meetingLink: 'https://meet.google.com/event-status-latest',
          }),
          updateEvent: vi.fn().mockResolvedValue(undefined),
          deleteEvent: vi.fn().mockResolvedValue(undefined),
        },
        payments: {
          createCheckoutSession: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
          sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-booking-confirmed' }),
          sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
        },
      } as any,
    });
    const created = await createPayLaterBooking({
      slotStart: '2026-03-22T10:00:00.000Z',
      slotEnd: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Latest Event Status',
      clientEmail: 'event-status-latest@example.com',
      clientPhone: '+41000000063',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx as any);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/event-status?booking_id=${created.bookingId}&booking_event_type=BOOKING_FORM_SUBMITTED&token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_event_type: 'BOOKING_FORM_SUBMITTED',
      booking_id: created.bookingId,
      booking_status: 'PENDING',
      next_action_label: 'Manage Booking',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_event_status_request_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        selector_mode: 'latest_of_type',
      }),
    }));
  });
});
