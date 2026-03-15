import { mockState } from '../mock-state.js';
import type { ConfirmationEmailOptions, IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event } from '../../types.js';
import {
  buildBookingCancellationEmail,
  buildBookingConfirmationEmail,
  buildBookingConfirmRequestEmail,
  buildBookingExpiredEmail,
  buildBookingFollowupEmail,
  buildBookingPaymentDueEmail,
  buildBookingPaymentReminderEmail,
  buildBookingReminder24hEmail,
  buildContactMessageEmail,
  buildEventConfirmationEmail,
  buildEventConfirmRequestEmail,
  buildEventFollowupEmail,
  buildEventReminder24hEmail,
  type BuiltEmailMessage,
} from './resend.js';

export class MockEmailProvider implements IEmailProvider {
  private send(
    message: BuiltEmailMessage,
    metadata: {
      bookingId?: string | null;
      eventId?: string | null;
      contactMessageId?: string | null;
    } = {},
  ): SendResult {
    const messageId = `mock_msg_${crypto.randomUUID()}`;
    const { kind, payload } = message;
    const sentAt = new Date().toISOString();

    mockState.sentEmails.push({
      id: messageId,
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      kind,
      email_kind: kind,
      replyTo: payload.replyTo,
      text: payload.text,
      html: payload.html,
      body: payload.text,
      sentAt,
      sent_at: sentAt,
      booking_id: metadata.bookingId ?? null,
      event_id: metadata.eventId ?? null,
      contact_message_id: metadata.contactMessageId ?? null,
    });

    console.info('[email:mock] capture', JSON.stringify({
      provider: 'mock',
      kind,
      to: payload.to,
      subject: payload.subject,
      has_html: Boolean(payload.html),
      text_length: payload.text.length,
      html_length: payload.html ? payload.html.length : 0,
      branch_taken: 'capture_exact_provider_payload',
      deny_reason: null,
    }));

    return {
      messageId,
      debug: {
        provider: 'mock',
        kind,
        preview: 'captured_exact_provider_payload',
      },
    };
  }

  async sendContactMessage(name: string, email: string, message: string, topic?: string | null): Promise<SendResult> {
    return this.send(buildContactMessageEmail(name, email, message, topic));
  }

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string, confirmationWindowMinutes: number): Promise<SendResult> {
    return this.send(buildBookingConfirmRequestEmail(booking, confirmUrl, confirmationWindowMinutes), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingPaymentDue(
    booking: Booking,
    payUrl: string,
    manageUrl: string,
    paymentDueAt: string,
  ): Promise<SendResult> {
    return this.send(buildBookingPaymentDueEmail(booking, payUrl, manageUrl, paymentDueAt), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingConfirmation(
    booking: Booking,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
    policyText = '',
    options: ConfirmationEmailOptions = {},
  ): Promise<SendResult> {
    return this.send(buildBookingConfirmationEmail(booking, manageUrl, invoiceUrl, payUrl, policyText, options), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult> {
    return this.send(buildBookingPaymentReminderEmail(booking, payUrl), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    return this.send(buildBookingReminder24hEmail(booking, manageUrl), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.send(buildBookingFollowupEmail(booking, confirmUrl), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.send(buildBookingCancellationEmail(booking, startNewBookingUrl), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendBookingExpired(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.send(buildBookingExpiredEmail(booking, startNewBookingUrl), {
      bookingId: booking.id,
      eventId: booking.event_id ?? null,
    });
  }

  async sendEventConfirmRequest(booking: Booking, event: Event, confirmUrl: string): Promise<SendResult> {
    return this.send(buildEventConfirmRequestEmail(booking, event, confirmUrl), {
      bookingId: booking.id,
      eventId: event.id,
    });
  }

  async sendEventConfirmation(
    booking: Booking,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
    policyText = '',
    options: ConfirmationEmailOptions = {},
  ): Promise<SendResult> {
    return this.send(buildEventConfirmationEmail(booking, event, manageUrl, invoiceUrl, payUrl, policyText, options), {
      bookingId: booking.id,
      eventId: event.id,
    });
  }

  async sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult> {
    return this.send(buildEventReminder24hEmail(booking, event, manageUrl), {
      bookingId: booking.id,
      eventId: event.id,
    });
  }

  async sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult> {
    return this.send(buildEventFollowupEmail(booking, event, actionUrl), {
      bookingId: booking.id,
      eventId: event.id,
    });
  }
}
