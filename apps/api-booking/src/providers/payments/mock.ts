import type {
  IPaymentsProvider,
  CreateCheckoutParams,
  CheckoutSession,
  CreateInvoiceParams,
  InvoiceRecord,
  StripePaymentEvent,
} from './interface.js';

export class MockPaymentsProvider implements IPaymentsProvider {
  constructor(private readonly siteUrl: string) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const sessionId = `mock_cs_${crypto.randomUUID()}`;
    const customerId = params.existingStripeCustomerId ?? `mock_cus_${crypto.randomUUID()}`;
    const amount = params.lineItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);
    const currency = params.lineItems[0]?.currency ?? 'CHF';

    const checkoutUrl = `${this.siteUrl}/dev-pay?session_id=${sessionId}&booking_id=${params.bookingId}&amount=${amount}&currency=${currency}`;

    console.log(`[payments:mock] createCheckoutSession → ${sessionId}`, {
      bookingId: params.bookingId,
      amount,
    });

    return {
      sessionId,
      checkoutUrl,
      amount,
      currency,
      customerId,
      paymentIntentId: null,
      rawPayload: {
        booking_id: params.bookingId,
        customer_id: customerId,
        metadata: params.metadata ?? {},
      },
    };
  }

  async createInvoice(params: CreateInvoiceParams): Promise<InvoiceRecord> {
    const invoiceId = `mock_in_${crypto.randomUUID()}`;
    const customerId = params.existingStripeCustomerId ?? `mock_cus_${crypto.randomUUID()}`;
    const invoiceUrl = `${this.siteUrl}/mock-invoice/${invoiceId}?booking_id=${encodeURIComponent(params.bookingId)}&amount=${params.amount}&currency=${encodeURIComponent(params.currency)}&email=${encodeURIComponent(params.customerEmail)}`;

    console.log(`[payments:mock] createInvoice → ${invoiceId}`, {
      bookingId: params.bookingId,
      amount: params.amount,
      customerEmail: params.customerEmail,
    });

    return {
      invoiceId,
      invoiceUrl,
      amount: params.amount,
      currency: params.currency,
      customerId,
      paymentIntentId: null,
      paymentLinkId: null,
      rawPayload: {
        booking_id: params.bookingId,
        customer_id: customerId,
        metadata: params.metadata ?? {},
      },
    };
  }

  async parseWebhookEvent(
    rawBody: string,
    _signature: string,
    _secret: string,
  ): Promise<StripePaymentEvent | null> {
    try {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      const eventType = body['type'];
      const data = body['data'];
      const object = (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>)['object'] === 'object')
        ? (data as Record<string, unknown>)['object'] as Record<string, unknown>
        : null;
      if (!object || typeof eventType !== 'string') return null;

      const metadata = (object['metadata'] as Record<string, string>) ?? {};
      if (eventType === 'checkout.session.completed') {
        return {
          eventType,
          checkoutSessionId: object['id'] as string,
          paymentIntentId: (object['payment_intent'] as string | null) ?? null,
          invoiceId: (object['invoice'] as string | null) ?? null,
          invoiceUrl: `${this.siteUrl}/mock-invoice/${object['id'] as string}.pdf`,
          paymentLinkId: null,
          amount: Number(object['amount_total'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? (object['client_reference_id'] as string | null) ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          rawPayload: body,
        };
      }

      if (eventType === 'invoice.paid') {
        return {
          eventType,
          checkoutSessionId: null,
          paymentIntentId: (object['payment_intent'] as string | null) ?? null,
          invoiceId: object['id'] as string,
          invoiceUrl: (object['hosted_invoice_url'] as string | null) ?? `${this.siteUrl}/mock-invoice/${object['id'] as string}.pdf`,
          paymentLinkId: null,
          amount: Number(object['amount_paid'] ?? object['amount_due'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          rawPayload: body,
        };
      }

      if (eventType === 'payment_intent.succeeded') {
        return {
          eventType,
          checkoutSessionId: null,
          paymentIntentId: object['id'] as string,
          invoiceId: (object['invoice'] as string | null) ?? null,
          invoiceUrl: null,
          paymentLinkId: null,
          amount: Number(object['amount_received'] ?? object['amount'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          rawPayload: body,
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
