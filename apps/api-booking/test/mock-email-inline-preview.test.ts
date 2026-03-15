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
  it('includes a preview on pay-later booking submit in mock mode and omits it when email mode is resend', async () => {
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
    expect(noUiData).not.toHaveProperty('mock_email_preview');
    expect(noUiCtx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_pay_later_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'skip_mock_email_preview_ui_test_mode_not_enabled',
        deny_reason: 'ui_test_mode_not_enabled',
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
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'contact_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));
  });

  it('includes a preview on confirm and resolves payment-status previews by booking linkage', async () => {
    const ctx = makeCtx();
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
    expect(confirmData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(pendingAData.booking_id, 'booking_confirmation'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirm_mock_email_preview_decision',
      context: expect.objectContaining({
        branch_taken: 'include_mock_email_preview',
      }),
    }));

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
    const sessionIdA = new URL(payNowA.checkout_url).searchParams.get('session_id');
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

    const statusResponse = await handleRequest(
      jsonRequest(`/api/bookings/payment-status?session_id=${encodeURIComponent(String(sessionIdA))}`),
      ctx,
    );
    const statusData = await statusResponse.json() as Record<string, any>;
    expect(statusData.mock_email_preview).toEqual(expect.objectContaining({
      email_id: bookingEmailId(payNowA.booking_id, 'booking_confirmation'),
    }));
    expect(statusData.mock_email_preview.email_id).not.toBe(bookingEmailId(payNowB.booking_id, 'booking_confirmation'));
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
});
