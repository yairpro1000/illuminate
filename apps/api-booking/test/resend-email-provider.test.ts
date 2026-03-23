import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: sendMock,
    };
  },
}));

describe('Resend payment-due email payload', () => {
  const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    consoleInfoSpy.mockClear();
  });

  it('sends visible pay-later HTML content with the original image header preserved', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendBookingPaymentDue({
      id: 'bk-1',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/continue-payment.html?token=m1.test', 'https://letsilluminate.co/manage.html?token=m1.test', '2026-03-18T10:00:00.000Z');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.text).toContain('Please complete payment by');
    expect(payload.html).toContain('Complete payment');
    expect(payload.html).toContain('ILLUMINATE');
    expect(payload.html).toContain('https://pub-f85abd8d9116422ab218850bcd23aa61.r2.dev/ILLUMINATE_hero.png');
    expect(payload.html).toContain('Payment due');
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[email:resend] send_attempt',
      expect.stringContaining('"kind":"booking_payment_due"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[email:resend] send_result',
      expect.stringContaining('"branch_taken":"resend_send_succeeded"'),
    );
  });

  it('renders confirmed-but-unpaid confirmation content without invoice row and with continue-payment CTA', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendBookingConfirmation({
      id: 'bk-2',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any,
    'https://letsilluminate.co/manage.html?token=m1.test',
    null,
    'https://letsilluminate.co/continue-payment.html?token=m1.test',
    '',
    {
      paymentSettled: false,
      paymentDueAt: '2026-03-18T10:00:00.000Z',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.subject).toBe('Your session on Mar 19 is confirmed');
    expect(payload.text).toContain('payment is still pending');
    expect(payload.text).not.toContain('Invoice:');
    expect(payload.text).toContain('Complete payment: https://letsilluminate.co/continue-payment.html?token=m1.test');
    expect(payload.text).toContain('For online sessions, a video conference link will be sent at the day of the session.');
    expect(payload.html).toContain('Payment due');
    expect(payload.html).not.toContain('Invoice');
    expect(payload.html).toContain('Complete payment');
    expect(payload.html).toContain('For online sessions, a video conference link will be sent at the day of the session.');
  });

  it('includes the receipt link in settled confirmation emails when available', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendBookingConfirmation({
      id: 'bk-2b',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any,
    'https://letsilluminate.co/manage.html?token=m1.test',
    'https://letsilluminate.co/mock-invoice/in_123',
    null,
    '',
    {
      paymentSettled: true,
      receiptUrl: 'https://pay.stripe.com/receipts/ch_123',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.text).toContain('Receipt: https://pay.stripe.com/receipts/ch_123');
    expect(payload.text).toContain('For online sessions, a video conference link will be sent at the day of the session.');
    expect(payload.html).toContain('View invoice');
    expect(payload.html).toContain('View receipt');
    expect(payload.html.match(/Add to Google Calendar/g)?.length ?? 0).toBe(1);
    expect(payload.html).toContain('For online sessions, a video conference link will be sent at the day of the session.');
  });

  it('uses rescheduled confirmation copy when the booking confirmation email is triggered by a reschedule', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendBookingConfirmation({
      id: 'bk-2c',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-21T14:00:00.000Z',
      ends_at: '2026-03-21T15:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any,
    'https://letsilluminate.co/manage.html?token=m1.test',
    null,
    null,
    '',
    {
      paymentSettled: true,
      rescheduled: true,
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.subject).toBe('Your session has been rescheduled to Mar 21');
    expect(payload.text).toContain('Your session has been rescheduled.');
    expect(payload.html).toContain('Your session has been rescheduled.');
    expect(payload.html).toContain('Manage booking');
  });

  it('includes the hold-window copy in event confirmation-request emails', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendEventConfirmRequest({
      id: 'bk-3',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      event_id: 'evt-1',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, {
      id: 'evt-1',
      title: 'ILLUMINATE Evening',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/confirm.html?token=abc', 15);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.text).toContain('Your spot is kindly held for the next 15 minutes before expiring.');
    expect(payload.html).toContain('Your spot is kindly held for the next 15 minutes before expiring.');
  });

  it('uses the updated session cancellation copy and rebooking links', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendBookingCancellation({
      id: 'bk-3b',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/sessions.html', {
      includeRefundNotice: true,
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.subject).toBe('Your session on Mar 19 has been cancelled');
    expect(payload.text).toContain('We are sorry to see you go.');
    expect(payload.text).toContain('If a refund applies, you\'ll receive a separate confirmation email.');
    expect(payload.text).toContain('You can always book again: https://letsilluminate.co/sessions.html');
    expect(payload.text).toContain('Contact Yair: https://letsilluminate.co/contact.html');
    expect(payload.html).toContain('We are sorry to see you go.');
    expect(payload.html).toContain('If a refund applies, you\'ll receive a separate confirmation email.');
    expect(payload.html).toContain('You can always');
    expect(payload.html).toContain('Book again');
    expect(payload.html).toContain('Contact Yair');
  });

  it('uses event-specific cancellation copy for canceled event bookings', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendEventCancellation({
      id: 'bk-4',
      event_id: 'evt-2',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, {
      id: 'evt-2',
      title: 'ILLUMINATE Evening',
      starts_at: '2026-03-19T10:00:00.000Z',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/evenings.html');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.subject).toBe('Your booking for ILLUMINATE Evening has been cancelled');
    expect(payload.text).toContain('We are sorry to see you go.');
    expect(payload.text).toContain('Your event booking for ILLUMINATE Evening on');
    expect(payload.text).toContain('You can always book again: https://letsilluminate.co/evenings.html');
    expect(payload.text).toContain('Contact Yair: https://letsilluminate.co/contact.html');
    expect(payload.text).not.toContain('Your session on');
    expect(payload.html).toContain('We are sorry to see you go.');
    expect(payload.html).toContain('You can always');
    expect(payload.html).toContain('Your event booking has been cancelled.');
    expect(payload.html).toContain('Book again');
    expect(payload.html).toContain('Contact Yair');
  });

  it('sends refund confirmation copy with customer-facing document links only', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendRefundConfirmation({
      id: 'bk-5',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, {
      subjectTitle: 'Cycle Session',
      amount: 150,
      currency: 'CHF',
      explanation: 'Your refund has been processed.',
      invoiceReference: 'in_123',
      creditNoteReference: 'cn_123',
      refundReference: 're_123',
      creditNoteUrl: 'https://letsilluminate.co/mock-credit-note/cn_123',
      receiptUrl: 'https://pay.stripe.com/receipts/ch_123',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.subject).toBe('Your refund for Cycle Session');
    expect(payload.text).toContain('Your refund has been processed.');
    expect(payload.text).toContain('Amount: CHF 150.00');
    expect(payload.text).toContain('Invoice: in_123');
    expect(payload.text).not.toContain('Credit note: cn_123');
    expect(payload.text).not.toContain('Refund reference: re_123');
    expect(payload.text).toContain('Credit note link: https://letsilluminate.co/mock-credit-note/cn_123');
    expect(payload.text).toContain('Receipt: https://pay.stripe.com/receipts/ch_123');
    expect(payload.html).toContain('Amount');
    expect(payload.html).toContain('CHF 150.00');
    expect(payload.html).toContain('View receipt');
    expect(payload.html).toContain('View credit note &rarr;');
    expect(payload.html).not.toContain('Refund reference');
  });

  it('omits refund document links when Stripe did not provide URLs', async () => {
    const { ResendEmailProvider } = await import('../src/providers/email/resend.js');
    const provider = new ResendEmailProvider('test-key');

    await provider.sendRefundConfirmation({
      id: 'bk-6',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, {
      subjectTitle: 'Cycle Session',
      amount: 150,
      currency: 'CHF',
      explanation: 'Your refund has been processed.',
      invoiceReference: 'in_123',
      refundReference: 're_123',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.text).not.toContain('Credit note link:');
    expect(payload.text).not.toContain('Receipt: https://');
    expect(payload.html).not.toContain('View credit note');
    expect(payload.html).not.toContain('View receipt');
  });
});
