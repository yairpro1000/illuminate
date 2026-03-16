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
    expect(payload.html).toContain('ILLUMINATE_hero.png');
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

  it('renders confirmed-but-unpaid confirmation content with invoice row and confirmed subject', async () => {
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
    'https://letsilluminate.co/mock-invoice/in_123',
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
    expect(payload.text).toContain('Invoice: https://letsilluminate.co/mock-invoice/in_123');
    expect(payload.html).toContain('Payment due');
    expect(payload.html).toContain('Invoice');
    expect(payload.html).toContain('Click here');
    expect(payload.html).toContain('Complete payment');
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
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/confirm.html?token=abc', 15);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, string>;
    expect(payload.text).toContain('Your spot is kindly held for the next 15 minutes before expiring.');
    expect(payload.html).toContain('Your spot is kindly held for the next 15 minutes before expiring.');
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
    expect(payload.subject).toBe('Your event booking has been cancelled');
    expect(payload.text).toContain('Your event booking for ILLUMINATE Evening on');
    expect(payload.text).not.toContain('Your session on');
    expect(payload.html).toContain('Your event booking has been cancelled.');
    expect(payload.html).toContain('Book another event');
  });
});
