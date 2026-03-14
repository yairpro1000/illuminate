import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: {
      send,
    },
  })),
}));

import { ResendEmailProvider } from '../src/providers/email/resend.js';
import type { Booking } from '../src/types.js';

function makeBooking(): Booking {
  return {
    id: 'booking-1',
    client_id: 'client-1',
    event_id: null,
    session_type_id: 'session-1',
    booking_type: 'PAY_LATER',
    starts_at: '2026-03-16T10:00:00.000Z',
    ends_at: '2026-03-16T11:30:00.000Z',
    timezone: 'Europe/Zurich',
    google_event_id: null,
    meeting_provider: null,
    meeting_link: null,
    address_line: 'Via Example 1, 6900 Lugano',
    maps_url: 'https://maps.example/1',
    price: 180,
    currency: 'CHF',
    coupon_code: null,
    current_status: 'EXPIRED',
    notes: null,
    created_at: '2026-03-14T08:00:00.000Z',
    updated_at: '2026-03-14T08:00:00.000Z',
    client_first_name: 'Yair',
    client_last_name: 'Benharroch',
    client_email: 'yair@example.com',
    client_phone: '+41000000000',
    session_type_title: 'First Clarity Session',
  };
}

describe('Resend booking expiry email layout', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('renders the restart hint after the summary block and before the CTA button', async () => {
    const provider = new ResendEmailProvider('resend-key');

    await provider.sendBookingExpired(makeBooking(), 'https://example.com/sessions.html');

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { html: string };
    const html = payload.html;
    const detailIndex = html.indexOf('detail-block');
    const helperIndex = html.indexOf("It's ok, you can:");
    const buttonIndex = html.indexOf('Book again');

    expect(detailIndex).toBeGreaterThan(-1);
    expect(helperIndex).toBeGreaterThan(detailIndex);
    expect(buttonIndex).toBeGreaterThan(helperIndex);
  });
});
