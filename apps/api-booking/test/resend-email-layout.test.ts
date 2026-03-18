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
import type { Booking, Event } from '../src/types.js';

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

function makeEvent(): Event {
  return {
    id: 'event-1',
    slug: 'listening-to-the-body',
    title: 'Listening to the Body',
    description: 'A guided event.',
    starts_at: '2026-04-10T17:00:00.000Z',
    ends_at: '2026-04-10T19:00:00.000Z',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.example/event-1',
    is_paid: false,
    price: null,
    currency: null,
    capacity: 20,
    is_visible: true,
    created_at: '2026-03-14T08:00:00.000Z',
    updated_at: '2026-03-14T08:00:00.000Z',
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

  it('renders event confirmation date and time in separate rows using the booking timezone labels', async () => {
    const provider = new ResendEmailProvider('resend-key');

    await provider.sendEventConfirmation(
      makeBooking(),
      makeEvent(),
      'https://example.com/manage.html?token=tok-1',
      null,
      null,
      'Booking policy\nRule one\nRule two\nContact',
    );

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { html: string };
    const html = payload.html;

    expect(html).toContain('>Date<');
    expect(html).toContain('>Time<');
    expect(html).toContain('19:00\u201321:00 (Europe/Zurich)');
    expect(html).not.toContain('Date &amp; time');
    expect(html).not.toContain('UTC');
  });
});
