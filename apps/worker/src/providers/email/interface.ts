import type { Booking, Event, EventRegistration } from '../../types.js';

export interface SendResult {
  messageId: string;
  debug?: Record<string, unknown>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly debug: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

export interface IEmailProvider {
  /** Generic website contact message. */
  sendContactMessage(name: string, email: string, message: string): Promise<SendResult>;

  /**
   * Pay-later booking: ask user to confirm their email address.
   * confirmUrl points to /confirm?type=booking&token=...&id=...
   */
  sendBookingConfirmRequest(booking: Booking, confirmUrl: string): Promise<SendResult>;

  /**
   * Pay-later booking: email confirmed, payment now due.
   * payUrl points to the Stripe checkout URL or /api/bookings/pay-now.
   */
  sendBookingPaymentDue(booking: Booking, payUrl: string, manageUrl: string): Promise<SendResult>;

  /**
   * Pay-now or pay-later (after payment): booking fully confirmed.
   * invoiceUrl may be null if payment is cash/pending.
   */
  sendBookingConfirmation(booking: Booking, manageUrl: string, invoiceUrl: string | null): Promise<SendResult>;

  /** Reminder sent before payment_due_at (pay-later). */
  sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult>;

  /** 24h before the session. */
  sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult>;

  /** +2h follow-up when email not yet confirmed. */
  sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult>;

  /** Booking cancelled (by user or auto-cancel). */
  sendBookingCancellation(booking: Booking): Promise<SendResult>;

  // ── Event registrations ──────────────────────────────────────────────────────

  /** Free event: ask user to confirm their email. */
  sendRegistrationConfirmRequest(
    registration: EventRegistration,
    event: Event,
    confirmUrl: string,
  ): Promise<SendResult>;

  /** Paid event + free event: registration confirmed. */
  sendRegistrationConfirmation(
    registration: EventRegistration,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
  ): Promise<SendResult>;

  /** 24h before the event. */
  sendRegistrationReminder24h(
    registration: EventRegistration,
    event: Event,
    manageUrl: string,
  ): Promise<SendResult>;

  /** +2h follow-up for unconfirmed or unpaid registrations. */
  sendRegistrationFollowup(
    registration: EventRegistration,
    event: Event,
    actionUrl: string,
  ): Promise<SendResult>;
}
