import type { IPaymentsProvider, CreateCheckoutParams, CheckoutSession, StripeCheckoutEvent } from './interface.js';

export class MockPaymentsProvider implements IPaymentsProvider {
  constructor(private readonly siteUrl: string) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const sessionId = `mock_cs_${crypto.randomUUID()}`;
    const amountCents = params.lineItems.reduce((sum, item) => sum + item.amountCents * item.quantity, 0);
    const currency = params.lineItems[0]?.currency ?? 'CHF';

    // Point to the dev payment page in the site
    const checkoutUrl = `${this.siteUrl}/dev-pay?session_id=${sessionId}&ref_id=${params.referenceId}&ref_kind=${params.referenceKind}&amount=${amountCents}&currency=${currency}`;

    console.log(`[payments:mock] createCheckoutSession → ${sessionId}`, {
      referenceId: params.referenceId,
      referenceKind: params.referenceKind,
      amountCents,
    });

    return { sessionId, checkoutUrl, amountCents, currency };
  }

  async parseWebhookEvent(
    rawBody: string,
    _signature: string,
    _secret: string,
  ): Promise<StripeCheckoutEvent | null> {
    // In mock mode the webhook body is sent as plain JSON (no Stripe signature)
    try {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      if (body['type'] !== 'checkout.session.completed') return null;

      const session = body['data'] as Record<string, unknown>;
      const metadata = (session['metadata'] as Record<string, string>) ?? {};

      return {
        sessionId:       session['id'] as string,
        paymentIntentId: (session['payment_intent'] as string | null) ?? null,
        invoiceId:       null,
        invoiceUrl:      `${this.siteUrl}/mock-invoice/${session['id'] as string}.pdf`,
        amountTotal:     (session['amount_total'] as number) ?? 0,
        currency:        (session['currency'] as string) ?? 'chf',
        referenceId:     metadata['reference_id'] ?? '',
        referenceKind:   (metadata['reference_kind'] as 'booking' | 'event_registration') ?? 'booking',
      };
    } catch {
      return null;
    }
  }
}
