import type { Booking, Event } from '../../types.js';

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

export interface ConfirmationEmailOptions {
  paymentSettled?: boolean;
  paymentDueAt?: string | null;
}

export interface IEmailProvider {
  /** Generic website contact message. */
  sendContactMessage(name: string, email: string, message: string, topic?: string | null): Promise<SendResult>;

  /** Session pay-later: ask user to confirm email. */
  sendBookingConfirmRequest(booking: Booking, confirmUrl: string, confirmationWindowMinutes: number): Promise<SendResult>;

  /** Checkout follow-up: payment not completed and hold nearing expiry. */
  sendBookingPaymentDue(
    booking: Booking,
    payUrl: string,
    manageUrl: string,
    paymentDueAt: string,
  ): Promise<SendResult>;

  /** Session confirmation after payment/cash. */
  sendBookingConfirmation(
    booking: Booking,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
    policyText?: string,
    options?: ConfirmationEmailOptions,
  ): Promise<SendResult>;

  /** Session reminder before pay-later due threshold. */
  sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult>;

  /** Session reminder 24h before session. */
  sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult>;

  /** Session follow-up when email not yet confirmed. */
  sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult>;

  /** Session cancellation. Optionally include a start-new-booking URL. */
  sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult>;

  /** Session expired because it was not confirmed/paid in time. Optionally include a start-new-booking URL. */
  sendBookingExpired(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult>;

  /** Event (free) pending-confirmation request. */
  sendEventConfirmRequest(booking: Booking, event: Event, confirmUrl: string): Promise<SendResult>;

  /** Event confirmation for free-confirmed or paid-success. */
  sendEventConfirmation(
    booking: Booking,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
    policyText?: string,
    options?: ConfirmationEmailOptions,
  ): Promise<SendResult>;

  /** Event reminder 24h before event. */
  sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult>;

  /** Event follow-up for incomplete confirmation/payment flows. */
  sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult>;
}
