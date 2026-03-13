import type { AppContext } from '../router.js';
import { ok } from '../lib/errors.js';
import { confirmBookingPayment } from '../services/booking-service.js';

// POST /api/stripe/webhook
export async function handleStripeWebhook(request: Request, ctx: AppContext): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  const event = await ctx.providers.payments.parseWebhookEvent(
    rawBody,
    signature,
    ctx.env.STRIPE_WEBHOOK_SECRET ?? '',
  );

  if (!event) {
    return ok({ received: true, handled: false });
  }

  const payment = await ctx.providers.repository.getPaymentByStripeSessionId(event.sessionId);
  if (!payment) {
    ctx.logger.warn('webhook: no payment record for session', { sessionId: event.sessionId });
    return ok({ received: true, handled: false });
  }

  if (payment.status === 'SUCCEEDED') {
    return ok({ received: true, handled: true, idempotent: true });
  }

  await confirmBookingPayment(
    {
      id: payment.id,
      booking_id: payment.booking_id,
      provider_payment_id: payment.provider_payment_id,
    },
    {
      paymentIntentId: event.paymentIntentId,
      invoiceId: event.invoiceId,
      invoiceUrl: event.invoiceUrl,
    },
    {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
    },
  );

  return ok({ received: true, handled: true });
}
