import type { IPaymentsProvider, CreateCheckoutParams, CheckoutSession, StripeCheckoutEvent } from './interface.js';

export class MockPaymentsProvider implements IPaymentsProvider {
  constructor(private readonly siteUrl: string) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const sessionId = `mock_cs_${crypto.randomUUID()}`;
    const amountCents = params.lineItems.reduce((sum, item) => sum + item.amountCents * item.quantity, 0);
    const currency = params.lineItems[0]?.currency ?? 'CHF';

    const checkoutUrl = `${this.siteUrl}/dev-pay?session_id=${sessionId}&booking_id=${params.bookingId}&amount=${amountCents}&currency=${currency}`;

    console.log(`[payments:mock] createCheckoutSession → ${sessionId}`, {
      bookingId: params.bookingId,
      amountCents,
    });

    return { sessionId, checkoutUrl, amountCents, currency };
  }

  async parseWebhookEvent(
    rawBody: string,
    _signature: string,
    _secret: string,
  ): Promise<StripeCheckoutEvent | null> {
    try {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      if (body['type'] !== 'checkout.session.completed') return null;

      const session = body['data'] as Record<string, unknown>;
      const metadata = (session['metadata'] as Record<string, string>) ?? {};

      return {
        sessionId: session['id'] as string,
        paymentIntentId: (session['payment_intent'] as string | null) ?? null,
        invoiceId: null,
        invoiceUrl: `${this.siteUrl}/mock-invoice/${session['id'] as string}.pdf`,
        amountTotal: (session['amount_total'] as number) ?? 0,
        currency: (session['currency'] as string) ?? 'chf',
        bookingId: metadata['booking_id'] ?? '',
      };
    } catch {
      return null;
    }
  }
}
