import type { AppContext } from '../router.js';
import { ok, errorResponse } from '../lib/errors.js';
import { confirmBookingPayment } from '../services/booking-service.js';
import { confirmRegistrationPayment } from '../services/registration-service.js';

// POST /api/stripe/webhook
export async function handleStripeWebhook(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature') ?? '';

    const event = await ctx.providers.payments.parseWebhookEvent(
      rawBody,
      signature,
      ctx.env.STRIPE_WEBHOOK_SECRET ?? '',
    );

    if (!event) {
      // Event type not handled — Stripe expects 200 for unhandled events
      return ok({ received: true, handled: false });
    }

    ctx.logger.info('webhook: checkout.session.completed', {
      sessionId:     event.sessionId,
      referenceKind: event.referenceKind,
      referenceId:   event.referenceId,
    });

    // Idempotency check: if already processed, return 200 without re-running
    const payment = await ctx.providers.repository.getPaymentByStripeSessionId(event.sessionId);
    if (!payment) {
      ctx.logger.warn('webhook: no payment record for session', { sessionId: event.sessionId });
      return ok({ received: true, handled: false });
    }
    if (payment.status === 'succeeded') {
      ctx.logger.info('webhook: already processed (idempotent)', { sessionId: event.sessionId });
      return ok({ received: true, handled: true, idempotent: true });
    }

    const stripeData = {
      paymentIntentId: event.paymentIntentId,
      invoiceId:       event.invoiceId,
      invoiceUrl:      event.invoiceUrl,
    };

    const svcCtx = { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId };

    if (event.referenceKind === 'booking') {
      await confirmBookingPayment(payment, stripeData, svcCtx);
    } else {
      await confirmRegistrationPayment(payment, stripeData, svcCtx);
    }

    return ok({ received: true, handled: true });
  } catch (err) {
    ctx.logger.error('Webhook handler error', { err: String(err) });
    return errorResponse(err);
  }
}
