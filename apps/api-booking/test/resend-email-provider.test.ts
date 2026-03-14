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
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('sends visible HTML content without the oversized hero image header', async () => {
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
    expect(payload.html).not.toContain('ILLUMINATE_hero.png');
  });
});
