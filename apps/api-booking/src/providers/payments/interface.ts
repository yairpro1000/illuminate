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
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  sessionId: string;
  checkoutUrl: string;
  amount: number;
  currency: string;
}

export interface CreateInvoiceParams {
  title: string;
  description?: string;
  amount: number;
  currency: string;
  bookingId: string;
  customerEmail: string;
}

export interface InvoiceRecord {
  invoiceId: string;
  invoiceUrl: string;
  amount: number;
  currency: string;
}

/** Minimal subset of Stripe webhook event data this system cares about. */
export interface StripeCheckoutEvent {
  sessionId: string;
  paymentIntentId: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  amount: number;
  currency: string;
  bookingId: string;
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
  ): Promise<StripeCheckoutEvent | null>;
}
