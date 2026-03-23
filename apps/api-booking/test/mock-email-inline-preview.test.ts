import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { confirmBookingPayment } from '../src/services/booking-service.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { createOperationContext } from '../src/lib/execution.js';
import { makeEnv, makeLogger } from './admin-helpers.js';
import * as bookingPublicActionService from '../src/services/booking-public-action-service.js';

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

function makeCtx(envOverrides: Record<string, unknown> = {}) {
  const repository = new MockRepository();
  return {
    providers: {
      repository,
      email: new MockEmailProvider(),
      calendar: new MockCalendarProvider(),
      payments: new MockPaymentsProvider('https://example.com'),
      antibot: new MockAntiBotProvider(),
    } as any,
    env: makeEnv({
      SITE_URL: 'https://letsilluminate.co',
      ...envOverrides,
    }),
    logger: makeLogger(),
    requestId: 'req-inline-preview',
    correlationId: 'corr-inline-preview',
    operation: createOperationContext({
      appArea: 'website',
      requestId: 'req-inline-preview',
      correlationId: 'corr-inline-preview',
    }),
    executionCtx: undefined,
  } as any;
}

function jsonRequest(path: string, body?: Record<string, unknown>, options: { uiTestMode?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.10',
  };
  if (options.uiTestMode !== null) {
    headers['x-illuminate-ui-test-mode'] = options.uiTestMode || 'playwright';
  }
  return new Request(`https://api.local${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function bookingEmailId(bookingId: string, kind: string): string {
  const email = mockState.sentEmails.find((entry) => entry.booking_id === bookingId && entry.email_kind === kind);
  expect(email).toBeTruthy();
  return email!.id;
}

beforeEach(() => {
  resetMockState();
});

describe('mock email inline preview contract', () => {
  it('includes a preview on pay-later booking submit in mock mode even without ui-test mode, and omits it when email mode is resend', async () => {
    const mockCtx = makeCtx();
    const mockResponse = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-20T10:00:00.000Z',
      slot_end: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Maya',
      last_name: 'Preview',
      client_email: 'maya-preview@example.test',
      client_phone: '+41790000000',
      turnstile_token: 'ok',
    }), mockCtx);

    expect(mockResponse.status).toBe(200);
    await expect(mockResponse.json()).resolves.toEqual(expect.objectContaining({
      mock_email_preview: expect.objectContaining({
        email_id: expect.stringMatching(/^mock_msg_/),
        to: 'maya-preview@example.test',
        html_url: expect.stringContaining('/api/__dev/emails/'),
        html_content: expect.stringContaining('Confirm booking'),
      }),
    }));
    expect(mockCtx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_pay_later_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));

    resetMockState();
    const noUiCtx = makeCtx();
    const noUiResponse = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-20T12:00:00.000Z',
      slot_end: '2026-03-20T13:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Maya',
      last_name: 'NoUi',
      client_email: 'maya-no-ui@example.test',
      client_phone: '+41790000009',
      turnstile_token: 'ok',
    }, { uiTestMode: null }), noUiCtx);
    const noUiData = await noUiResponse.json() as Record<string, unknown>;
    expect(noUiData).toEqual(expect.objectContaining({
      mock_email_preview: expect.objectContaining({
        email_id: expect.stringMatching(/^mock_msg_/),
        to: 'maya-no-ui@example.test',
      }),
    }));
    expect(noUiCtx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_pay_later_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
        deny_reason: 'email_not_dispatched_in_request',
        ui_test_mode: null,
      }),
    }));

    resetMockState();
    const resendCtx = makeCtx({ EMAIL_MODE: 'resend' });
    const resendResponse = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-21T10:00:00.000Z',
      slot_end: '2026-03-21T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Maya',
      last_name: 'NoPreview',
      client_email: 'maya-no-preview@example.test',
      client_phone: '+41790000001',
      turnstile_token: 'ok',
    }), resendCtx);
    const resendData = await resendResponse.json() as Record<string, unknown>;
    expect(resendData).not.toHaveProperty('mock_email_preview');
    expect(resendCtx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_pay_later_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'skip_mock_email_preview_email_mode_not_mock',
        deny_reason: 'email_mode_not_mock',
      }),
    }));
  });

  it('includes a preview on contact form submission when the captured email exists', async () => {
    const ctx = makeCtx();
    const response = await handleRequest(jsonRequest('/api/contact', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada-inline@example.test',
      topic: 'sessions',
      message: 'Hello from the inline preview test',
      turnstile_token: 'ok',
    }), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      mock_email_preview: expect.objectContaining({
        to: 'hello@yairb.ch',
        html_url: expect.stringContaining('/api/__dev/emails/'),
        html_content: expect.stringContaining('Hello from the inline preview test'),
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'contact_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));
  });

  it('includes a preview on free event booking submit in mock mode without ui-test mode', async () => {
    const ctx = makeCtx();
    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid);
    expect(freeEvent).toBeTruthy();

    const response = await handleRequest(jsonRequest(`/api/events/${encodeURIComponent(String(freeEvent!.slug))}/book`, {
      first_name: 'Manual',
      last_name: 'Event',
      email: 'manual-event@example.test',
      phone: '+41790000010',
      turnstile_token: 'ok',
    }, { uiTestMode: null }), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      mock_email_preview: expect.objectContaining({
        email_id: expect.stringMatching(/^mock_msg_/),
        to: 'manual-event@example.test',
        html_url: expect.stringContaining('/api/__dev/emails/'),
        html_content: expect.stringContaining('Confirm my spot'),
        email_kind: 'event_confirm_request',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_booking_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
        ui_test_mode: null,
        has_mock_email_preview: true,
      }),
    }));
  });

  it('includes a preview on confirm and resolves payment-settled previews through booking-event status linkage', async () => {
    const ctx = makeCtx();
    const publicActionInfoSpy = vi.spyOn(bookingPublicActionService, 'getBookingPublicActionInfo');
    const email = 'same-recipient@example.test';

    const pendingA = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-22T10:00:00.000Z',
      slot_end: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Same',
      last_name: 'Recipient',
      client_email: email,
      client_phone: '+41790000002',
      turnstile_token: 'ok',
    }), ctx);
    const pendingAData = await pendingA.json() as { booking_id: string };
    const submitEventA = mockState.bookingEvents.find((entry) => entry.booking_id === pendingAData.booking_id && entry.event_type === 'BOOKING_FORM_SUBMITTED');
    const confirmToken = String(submitEventA?.payload?.['confirm_token'] ?? '');

    const confirmResponse = await handleRequest(jsonRequest(`/api/bookings/confirm?token=${encodeURIComponent(confirmToken)}`), ctx);
    const confirmData = await confirmResponse.json() as Record<string, any>;
    expect(confirmData.calendar_event).toEqual(expect.objectContaining({
      title: expect.any(String),
      start: '2026-03-22T10:00:00.000Z',
      end: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      description: expect.stringContaining('Google Meet:'),
    }));
    expect(confirmData.calendar_sync_pending_retry).toBe(false);
    expect(confirmData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(pendingAData.booking_id, 'booking_confirmation'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_request_started',
      context: expect.objectContaining({
        has_token: true,
        branch_taken: 'evaluate_confirm_token',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_token_redemption_completed',
      context: expect.objectContaining({
        booking_id: pendingAData.booking_id,
        branch_taken: 'booking_confirmation_redeemed',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_public_action_resolution_completed',
      context: expect.objectContaining({
        booking_id: pendingAData.booking_id,
        branch_taken: 'return_complete_payment_action',
        has_checkout_url: true,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_request_completed',
      context: expect.objectContaining({
        booking_id: pendingAData.booking_id,
        branch_taken: 'return_booking_confirmation_response',
      }),
    }));
    expect(publicActionInfoSpy).not.toHaveBeenCalled();

    const payNowAResponse = await handleRequest(jsonRequest('/api/bookings/pay-now', {
      slot_start: '2026-03-24T10:00:00.000Z',
      slot_end: '2026-03-24T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Same',
      last_name: 'Recipient',
      client_email: email,
      client_phone: '+41790000003',
      turnstile_token: 'ok',
    }), ctx);
    const payNowA = await payNowAResponse.json() as { booking_id: string; checkout_url: string };
    const paymentA = await ctx.providers.repository.getPaymentByBookingId(payNowA.booking_id);
    await confirmBookingPayment(paymentA!, {
      paymentIntentId: `pi_${payNowA.booking_id}`,
      invoiceId: `inv_${payNowA.booking_id}`,
      invoiceUrl: `https://example.com/invoice/${payNowA.booking_id}.pdf`,
    }, ctx);

    const payNowBResponse = await handleRequest(jsonRequest('/api/bookings/pay-now', {
      slot_start: '2026-03-25T10:00:00.000Z',
      slot_end: '2026-03-25T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Same',
      last_name: 'Recipient',
      client_email: email,
      client_phone: '+41790000004',
      turnstile_token: 'ok',
    }), ctx);
    const payNowB = await payNowBResponse.json() as { booking_id: string; checkout_url: string };
    const paymentB = await ctx.providers.repository.getPaymentByBookingId(payNowB.booking_id);
    await confirmBookingPayment(paymentB!, {
      paymentIntentId: `pi_${payNowB.booking_id}`,
      invoiceId: `inv_${payNowB.booking_id}`,
      invoiceUrl: `https://example.com/invoice/${payNowB.booking_id}.pdf`,
    }, ctx);

    const statusResponse = await handleRequest(jsonRequest(
      `/api/bookings/event-status?booking_id=${encodeURIComponent(payNowA.booking_id)}&booking_event_type=PAYMENT_SETTLED&token=${encodeURIComponent(`m1.${payNowA.booking_id}`)}`,
    ), ctx);
    const statusData = await statusResponse.json() as Record<string, any>;
    expect(statusResponse.status).toBe(200);
    expect(statusData.booking_event_type).toBe('PAYMENT_SETTLED');
    expect(statusData.calendar_event).toEqual(expect.objectContaining({
      title: expect.any(String),
      start: '2026-03-24T10:00:00.000Z',
      end: '2026-03-24T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      description: expect.stringContaining('Google Meet:'),
    }));
    expect(statusData.calendar_sync_pending_retry).toBe(false);
    expect(statusData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(payNowA.booking_id, 'booking_confirmation'),
    }));
    expect(statusData.mock_email_preview.email_id).not.toBe(bookingEmailId(payNowB.booking_id, 'booking_confirmation'));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_event_status_mock_email_preview_decision',
      context: expect.objectContaining({
        booking_id: payNowA.booking_id,
        booking_event_type: 'PAYMENT_SETTLED',
        branch_taken: 'include_mock_email_preview',
      }),
    }));
  });

  it('loads booking policy only once across the pay-later confirm request path', async () => {
    const ctx = makeCtx();
    const listSystemSettingsSpy = vi.spyOn(ctx.providers.repository, 'listSystemSettings');

    const createResponse = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-28T10:00:00.000Z',
      slot_end: '2026-03-28T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Cache',
      last_name: 'Confirm',
      client_email: 'cache-confirm@example.test',
      client_phone: '+41790000012',
      turnstile_token: 'ok',
    }), ctx);
    expect(createResponse.status).toBe(200);

    const bookingData = await createResponse.json() as { booking_id: string };
    const submission = mockState.bookingEvents.find((event) =>
      event.booking_id === bookingData.booking_id && event.event_type === 'BOOKING_FORM_SUBMITTED',
    );
    const confirmToken = String(submission?.payload?.['confirm_token'] ?? '');

    listSystemSettingsSpy.mockClear();

    const confirmResponse = await handleRequest(
      jsonRequest(`/api/bookings/confirm?token=${encodeURIComponent(confirmToken)}`),
      ctx,
    );

    expect(confirmResponse.status).toBe(200);
    expect(listSystemSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('includes a preview on manage cancel and skips it on manage reschedule', async () => {
    const ctx = makeCtx();
    const createResponse = await handleRequest(jsonRequest('/api/bookings/pay-later', {
      slot_start: '2026-03-26T10:00:00.000Z',
      slot_end: '2026-03-26T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      type: 'session',
      first_name: 'Manage',
      last_name: 'Flow',
      client_email: 'manage-flow@example.test',
      client_phone: '+41790000005',
      turnstile_token: 'ok',
    }), ctx);
    const bookingData = await createResponse.json() as { booking_id: string };
    const manageToken = `m1.${bookingData.booking_id}`;

    const rescheduleResponse = await handleRequest(jsonRequest('/api/bookings/reschedule', {
      token: manageToken,
      new_start: '2026-03-27T10:00:00.000Z',
      new_end: '2026-03-27T11:00:00.000Z',
      timezone: 'Europe/Zurich',
    }), ctx);
    const rescheduleData = await rescheduleResponse.json() as Record<string, unknown>;
    expect(rescheduleData).not.toHaveProperty('mock_email_preview');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_reschedule_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'skip_mock_email_preview_no_synchronous_email',
      }),
    }));

    const cancelResponse = await handleRequest(jsonRequest('/api/bookings/cancel', {
      token: manageToken,
    }), ctx);
    const cancelData = await cancelResponse.json() as Record<string, any>;
    expect(cancelData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(bookingData.booking_id, 'booking_cancellation'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_cancel_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));
  });

  it('includes event title in cancellation email for event bookings', async () => {
    const ctx = makeCtx();
    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid);
    expect(freeEvent).toBeTruthy();

    const bookResponse = await handleRequest(jsonRequest(`/api/events/${encodeURIComponent(String(freeEvent!.slug))}/book`, {
      first_name: 'Cancel',
      last_name: 'EventTest',
      email: 'cancel-event@example.test',
      phone: '+41790000011',
      turnstile_token: 'ok',
    }, { uiTestMode: null }), ctx);
    expect(bookResponse.status).toBe(200);
    const bookData = await bookResponse.json() as { booking_id: string };
    const manageToken = `m1.${bookData.booking_id}`;

    const cancelResponse = await handleRequest(jsonRequest('/api/bookings/cancel', {
      token: manageToken,
    }), ctx);
    expect(cancelResponse.status).toBe(200);
    const cancelData = await cancelResponse.json() as Record<string, any>;
    expect(cancelData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(bookData.booking_id, 'event_cancellation'),
      html_content: expect.stringContaining(freeEvent!.title),
    }));
  });

  it('logs the deny branch when confirm is called without a token', async () => {
    const ctx = makeCtx();

    const response = await handleRequest(jsonRequest('/api/bookings/confirm'), ctx);
    const data = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(data).toEqual(expect.objectContaining({
      error: 'BAD_REQUEST',
      message: 'token is required',
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_request_denied',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_confirm_token',
        deny_reason: 'confirm_token_missing',
      }),
    }));
  });
});
