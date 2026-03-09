import { describe, it, expect, vi } from 'vitest';
import { confirmBookingPayment } from '../src/services/booking-service.js';

function makeCtx(overrides: any = {}) {
  const providers = {
    repository: {
      updatePayment: vi.fn().mockResolvedValue(undefined),
      getBookingById: vi.fn().mockResolvedValue(null),
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
    const booking = { id: 'b1', status: 'expired', source: 'session' } as any;
    const ctx = makeCtx({ providers: { repository: { getBookingById: vi.fn().mockResolvedValue(booking) } } });
    await confirmBookingPayment(
      { id: 'p1', booking_id: 'b1', provider_payment_id: 'sess' },
      { paymentIntentId: 'pi', invoiceId: 'in', invoiceUrl: 'https://invoice' },
      ctx,
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Late payment for inactive booking — not reviving'), expect.any(Object));
  });
});
