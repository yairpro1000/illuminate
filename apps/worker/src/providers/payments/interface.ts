export interface CheckoutLineItem {
  name: string;
  description?: string;
  amountCents: number;
  currency: string;
  quantity: number;
}

export interface CreateCheckoutParams {
  lineItems: CheckoutLineItem[];
  /** Opaque reference stored in Stripe session metadata (booking_id or registration_id). */
  referenceId: string;
  /** 'booking' | 'event_registration' — stored in metadata for webhook routing. */
  referenceKind: 'booking' | 'event_registration';
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  sessionId: string;
  checkoutUrl: string;
  amountCents: number;
  currency: string;
}

/** Minimal subset of Stripe webhook event data this system cares about. */
export interface StripeCheckoutEvent {
  sessionId: string;
  paymentIntentId: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  amountTotal: number;
  currency: string;
  referenceId: string;
  referenceKind: 'booking' | 'event_registration';
}

export interface IPaymentsProvider {
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession>;

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
