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

/** Minimal subset of Stripe webhook event data this system cares about. */
export interface StripePaymentEvent {
  eventType: 'checkout.session.completed' | 'invoice.paid' | 'payment_intent.succeeded';
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  paymentLinkId: string | null;
  amount: number;
  currency: string;
  bookingId: string | null;
  customerId: string | null;
  siteUrl: string | null;
  rawPayload: Record<string, unknown>;
}

export interface IPaymentsProvider {
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession>;
  createInvoice(params: CreateInvoiceParams): Promise<InvoiceRecord>;

  /**
   * Verifies and parses an incoming Stripe webhook payload.
   * Throws if signature is invalid.
   * Returns null for event types this system does not handle.
   */
  parseWebhookEvent(
    rawBody: string,
    signature: string,
    secret: string,
  ): Promise<StripePaymentEvent | null>;
}
