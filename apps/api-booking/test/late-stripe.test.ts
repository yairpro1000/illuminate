import { describe, it, expect, vi } from 'vitest';
import { confirmBookingPayment } from '../src/services/booking-service.js';

function makeCtx(overrides: any = {}) {
  const providers = {
    repository: {
      updatePayment: vi.fn().mockResolvedValue(undefined),
      getBookingById: vi.fn().mockResolvedValue(null),
      createBookingEvent: vi.fn().mockResolvedValue(undefined),
    },
    email: {},
    payments: {},
  };
  const mergedRepo = { ...providers.repository, ...((overrides.providers && overrides.providers.repository) || {}) };
  const mergedProviders = { ...providers, ...(overrides.providers || {}), repository: mergedRepo };
  const ctx = {
    providers: mergedProviders,
    env: { SITE_URL: 'https://example.com' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    requestId: 'req',
  } as any;
  return ctx;
}

describe('Late Stripe payment handling', () => {
  it('does not revive expired bookings', async () => {
    const booking = { id: 'b1', current_status: 'EXPIRED', event_id: null } as any;
    const ctx = makeCtx({ providers: { repository: { getBookingById: vi.fn().mockResolvedValue(booking) } } });
    await confirmBookingPayment(
      {
        id: 'p1',
        booking_id: 'b1',
        status: 'PENDING',
        stripe_checkout_session_id: 'sess',
        stripe_payment_intent_id: null,
        stripe_invoice_id: null,
      },
      { paymentIntentId: 'pi', invoiceId: 'in', invoiceUrl: 'https://invoice' },
      ctx,
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Late payment for inactive booking — not reviving'), expect.any(Object));
  });
});
