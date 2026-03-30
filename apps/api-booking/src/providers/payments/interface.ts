export interface CheckoutLineItem {
  name: string;
  description?: string;
  amount: number;
  currency: string;
  quantity: number;
}

export interface CreateCheckoutParams {
  lineItems: CheckoutLineItem[];
  /** Opaque booking reference stored in provider metadata. */
  bookingId: string;
  siteUrl?: string | null;
  customerEmail: string;
  customerName?: string | null;
  existingStripeCustomerId?: string | null;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  sessionId: string;
  checkoutUrl: string;
  amount: number;
  currency: string;
  customerId: string | null;
  paymentIntentId: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface CreateInvoiceParams {
  title: string;
  description?: string;
  amount: number;
  currency: string;
  bookingId: string;
  siteUrl?: string | null;
  customerEmail: string;
  customerName?: string | null;
  existingStripeCustomerId?: string | null;
  dueDateIso?: string | null;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface InvoiceRecord {
  invoiceId: string;
  invoiceUrl: string;
  amount: number;
  currency: string;
  customerId: string | null;
  paymentIntentId: string | null;
  paymentLinkId: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface InvoiceDetails {
  invoiceId: string;
  invoiceUrl: string | null;
  paymentIntentId: string | null;
  paymentLinkId: string | null;
  amount: number | null;
  currency: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface PaymentArtifactDetails {
  invoiceId: string | null;
  invoiceUrl: string | null;
  paymentIntentId: string | null;
  paymentLinkId: string | null;
  chargeId: string | null;
  receiptUrl: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface CreateRefundParams {
  bookingId: string;
  paymentId: string;
  amount: number;
  currency: string;
  reasonText: string;
  siteUrl?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface RefundRecord {
  refundPath: 'credit_note' | 'direct_refund';
  refundStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  refundId: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  creditNoteDocumentUrl: string | null;
  receiptUrl: string | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  rawPayload?: Record<string, unknown> | null;
}

/** Minimal subset of Stripe webhook event data this system cares about. */
export interface StripePaymentWebhookEvent {
  eventCategory: 'payment';
  eventType: 'checkout.session.completed' | 'invoice.paid' | 'payment_intent.succeeded';
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  paymentLinkId: string | null;
  receiptUrl: string | null;
  amount: number;
  currency: string;
  bookingId: string | null;
  customerId: string | null;
  siteUrl: string | null;
  rawPayload: Record<string, unknown>;
}

/** Refund reconciliation events subscribed from Stripe. */
export interface StripeRefundWebhookEvent {
  eventCategory: 'refund';
  eventType: 'refund.created' | 'refund.updated' | 'refund.failed' | 'credit_note.created' | 'credit_note.updated' | 'credit_note.voided';
  refundId: string | null;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  creditNoteDocumentUrl: string | null;
  receiptUrl: string | null;
  paymentIntentId: string | null;
  invoiceId: string | null;
  refundStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | null;
  amount: number | null;
  currency: string | null;
  bookingId: string | null;
  rawPayload: Record<string, unknown>;
}

export type StripeWebhookEvent = StripePaymentWebhookEvent | StripeRefundWebhookEvent;

export interface IPaymentsProvider {
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession>;
  createInvoice(params: CreateInvoiceParams): Promise<InvoiceRecord>;
  updateCustomer(input: {
    customerId: string;
    email: string;
    name?: string | null;
  }): Promise<void>;
  getInvoiceDetails(invoiceId: string): Promise<InvoiceDetails>;
  getPaymentArtifactDetails(input: {
    paymentIntentId?: string | null;
    invoiceId?: string | null;
    chargeId?: string | null;
  }): Promise<PaymentArtifactDetails>;
  createRefund(params: CreateRefundParams): Promise<RefundRecord>;

  /**
   * Verifies and parses an incoming Stripe webhook payload.
   * Throws if signature is invalid.
   * Returns null for event types this system does not handle.
   */
  parseWebhookEvent(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<StripeWebhookEvent | null>;
}
