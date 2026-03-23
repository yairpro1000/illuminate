import type {
  IPaymentsProvider,
  CreateCheckoutParams,
  CheckoutSession,
  CreateInvoiceParams,
  InvoiceDetails,
  InvoiceRecord,
  PaymentArtifactDetails,
  CreateRefundParams,
  RefundRecord,
  StripeWebhookEvent,
} from './interface.js';

export class MockPaymentsProvider implements IPaymentsProvider {
  constructor(private readonly siteUrl: string) {}

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const siteUrl = params.siteUrl ?? this.siteUrl;
    const sessionId = `mock_cs_${crypto.randomUUID()}`;
    const customerId = params.existingStripeCustomerId ?? `mock_cus_${crypto.randomUUID()}`;
    const paymentIntentId = `mock_pi_${crypto.randomUUID()}`;
    const amount = params.lineItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);
    const currency = params.lineItems[0]?.currency ?? 'CHF';
    const successUrl = new URL(params.successUrl);
    const checkoutParams = new URLSearchParams({
      session_id: sessionId,
      booking_id: params.bookingId,
      amount: String(amount),
      currency,
    });
    const successToken = successUrl.searchParams.get('token');
    const successEventType = successUrl.searchParams.get('booking_event_type');
    if (successToken) checkoutParams.set('token', successToken);
    if (successEventType) checkoutParams.set('booking_event_type', successEventType);

    const checkoutUrl = `${siteUrl}/dev-pay.html?${checkoutParams.toString()}`;

    return {
      sessionId,
      checkoutUrl,
      amount,
      currency,
      customerId,
      paymentIntentId,
      rawPayload: {
        booking_id: params.bookingId,
        customer_id: customerId,
        payment_intent_id: paymentIntentId,
        metadata: params.metadata ?? {},
      },
    };
  }

  async createInvoice(params: CreateInvoiceParams): Promise<InvoiceRecord> {
    const siteUrl = params.siteUrl ?? this.siteUrl;
    const invoiceId = `mock_in_${crypto.randomUUID()}`;
    const customerId = params.existingStripeCustomerId ?? `mock_cus_${crypto.randomUUID()}`;
    const paymentIntentId = `mock_pi_${crypto.randomUUID()}`;
    const invoiceUrl = `${siteUrl}/mock-invoice/${invoiceId}?booking_id=${encodeURIComponent(params.bookingId)}&amount=${params.amount}&currency=${encodeURIComponent(params.currency)}&email=${encodeURIComponent(params.customerEmail)}`;

    return {
      invoiceId,
      invoiceUrl,
      amount: params.amount,
      currency: params.currency,
      customerId,
      paymentIntentId,
      paymentLinkId: null,
      rawPayload: {
        booking_id: params.bookingId,
        customer_id: customerId,
        payment_intent_id: paymentIntentId,
        metadata: params.metadata ?? {},
      },
    };
  }

  async getInvoiceDetails(invoiceId: string): Promise<InvoiceDetails> {
    return {
      invoiceId,
      invoiceUrl: `${this.siteUrl}/mock-invoice/${invoiceId}.pdf`,
      paymentIntentId: null,
      paymentLinkId: null,
      amount: null,
      currency: null,
      rawPayload: {
        id: invoiceId,
        hosted_invoice_url: `${this.siteUrl}/mock-invoice/${invoiceId}.pdf`,
      },
    };
  }

  async getPaymentArtifactDetails(input: {
    paymentIntentId?: string | null;
    invoiceId?: string | null;
    chargeId?: string | null;
  }): Promise<PaymentArtifactDetails> {
    const paymentIntentId = input.paymentIntentId
      ?? (input.invoiceId ? `mock_pi_${input.invoiceId}` : null);
    const chargeId = input.chargeId ?? (paymentIntentId ? `mock_ch_${paymentIntentId}` : null);
    const invoiceId = input.invoiceId
      ?? (paymentIntentId ? `mock_inv_${paymentIntentId}` : null);
    return {
      invoiceId,
      invoiceUrl: invoiceId ? `${this.siteUrl}/mock-invoice/${invoiceId}.pdf` : null,
      paymentIntentId,
      paymentLinkId: null,
      chargeId,
      receiptUrl: chargeId ? `${this.siteUrl}/mock-receipt/${chargeId}.html` : null,
      rawPayload: {
        invoice_id: invoiceId,
        payment_intent_id: paymentIntentId,
        charge_id: chargeId,
      },
    };
  }

  async createRefund(params: CreateRefundParams): Promise<RefundRecord> {
    const refundId = `mock_re_${crypto.randomUUID()}`;
    const creditNoteId = `mock_cn_${crypto.randomUUID()}`;
    const creditNoteDocumentUrl = `${this.siteUrl}/mock-credit-note/${creditNoteId}.pdf`;
    const receiptArtifact = await this.getPaymentArtifactDetails({
      paymentIntentId: params.stripePaymentIntentId ?? null,
      invoiceId: params.stripeInvoiceId ?? null,
    });

    return {
      refundPath: params.stripeInvoiceId ? 'credit_note' : 'direct_refund',
      refundStatus: 'SUCCEEDED',
      refundId,
      creditNoteId,
      creditNoteNumber: creditNoteId,
      creditNoteDocumentUrl,
      receiptUrl: receiptArtifact.receiptUrl,
      invoiceId: params.stripeInvoiceId ?? null,
      paymentIntentId: params.stripePaymentIntentId ?? null,
      amount: params.amount,
      currency: params.currency,
      rawPayload: {
        booking_id: params.bookingId,
        payment_id: params.paymentId,
        reason_text: params.reasonText,
        metadata: params.metadata ?? {},
      },
    };
  }

  async parseWebhookEvent(
    rawBody: string,
    _signature: string,
    _secret: string,
  ): Promise<StripeWebhookEvent | null> {
    try {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      const eventType = body['type'];
      const data = body['data'];
      const object = (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>)['object'] === 'object')
        ? (data as Record<string, unknown>)['object'] as Record<string, unknown>
        : null;
      if (!object || typeof eventType !== 'string') return null;

      const metadata = (object['metadata'] as Record<string, string>) ?? {};
      const siteUrl = metadata['site_url'] ?? this.siteUrl;
      if (eventType === 'checkout.session.completed') {
        return {
          eventCategory: 'payment',
          eventType,
          checkoutSessionId: object['id'] as string,
          paymentIntentId: (object['payment_intent'] as string | null) ?? null,
          invoiceId: (object['invoice'] as string | null) ?? null,
          invoiceUrl: `${siteUrl}/mock-invoice/${object['id'] as string}.pdf`,
          paymentLinkId: null,
          receiptUrl: null,
          amount: Number(object['amount_total'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? (object['client_reference_id'] as string | null) ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          siteUrl,
          rawPayload: body,
        };
      }

      if (eventType === 'invoice.paid') {
        return {
          eventCategory: 'payment',
          eventType,
          checkoutSessionId: null,
          paymentIntentId: (object['payment_intent'] as string | null) ?? null,
          invoiceId: object['id'] as string,
          invoiceUrl: (object['hosted_invoice_url'] as string | null) ?? `${siteUrl}/mock-invoice/${object['id'] as string}.pdf`,
          paymentLinkId: null,
          receiptUrl: `${siteUrl}/mock-receipt/mock_ch_${String(object['payment_intent'] ?? object['id'])}.html`,
          amount: Number(object['amount_paid'] ?? object['amount_due'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          siteUrl,
          rawPayload: body,
        };
      }

      if (eventType === 'payment_intent.succeeded') {
        return {
          eventCategory: 'payment',
          eventType,
          checkoutSessionId: null,
          paymentIntentId: object['id'] as string,
          invoiceId: (object['invoice'] as string | null) ?? null,
          invoiceUrl: null,
          paymentLinkId: null,
          receiptUrl: `${siteUrl}/mock-receipt/mock_ch_${object['id'] as string}.html`,
          amount: Number(object['amount_received'] ?? object['amount'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          customerId: (object['customer'] as string | null) ?? null,
          siteUrl,
          rawPayload: body,
        };
      }

      if (eventType === 'refund.created' || eventType === 'refund.updated' || eventType === 'refund.failed') {
        return {
          eventCategory: 'refund',
          eventType,
          refundId: object['id'] as string,
          creditNoteId: null,
          creditNoteNumber: null,
          creditNoteDocumentUrl: null,
          receiptUrl: `${siteUrl}/mock-receipt/${String(object['charge'] ?? `mock_ch_${String(object['payment_intent'] ?? object['id'])}`)}.html`,
          paymentIntentId: (object['payment_intent'] as string | null) ?? null,
          invoiceId: metadata['invoice_id'] ?? null,
          refundStatus: mapMockRefundStatus(object['status'] as string | null),
          amount: Number(object['amount'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          rawPayload: body,
        };
      }

      if (eventType === 'credit_note.created' || eventType === 'credit_note.updated' || eventType === 'credit_note.voided') {
        return {
          eventCategory: 'refund',
          eventType,
          refundId: Array.isArray(object['refunds']) && object['refunds'][0]
            && typeof (object['refunds'][0] as Record<string, unknown>)['refund'] === 'string'
            ? (object['refunds'][0] as Record<string, unknown>)['refund'] as string
            : null,
          creditNoteId: object['id'] as string,
          creditNoteNumber: (object['number'] as string | null) ?? (object['id'] as string | null) ?? null,
          creditNoteDocumentUrl: (object['pdf'] as string | null) ?? `${siteUrl}/mock-credit-note/${object['id'] as string}.pdf`,
          receiptUrl: metadata['payment_intent_id']
            ? `${siteUrl}/mock-receipt/mock_ch_${metadata['payment_intent_id']}.html`
            : null,
          paymentIntentId: metadata['payment_intent_id'] ?? null,
          invoiceId: (object['invoice'] as string | null) ?? metadata['invoice_id'] ?? null,
          refundStatus: eventType === 'credit_note.voided' ? 'CANCELED' : null,
          amount: Number(object['amount'] ?? object['subtotal_excluding_tax'] ?? 0) / 100,
          currency: String(object['currency'] ?? 'chf').toUpperCase(),
          bookingId: metadata['booking_id'] ?? null,
          rawPayload: body,
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}

function mapMockRefundStatus(status: string | null | undefined): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | null {
  if (status === 'pending' || status === 'requires_action') return 'PENDING';
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  if (status === 'canceled') return 'CANCELED';
  return null;
}
