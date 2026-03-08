import { mockState } from '../mock-state.js';
import type { IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event, EventRegistration } from '../../types.js';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

export class MockEmailProvider implements IEmailProvider {
  private send(to: string, kind: string, subject: string, body: string): SendResult {
    const messageId = `mock_msg_${crypto.randomUUID()}`;
    mockState.sentEmails.push({ to, subject, kind, body, sentAt: new Date().toISOString() });
    console.log(`[email:mock] → ${to} | ${kind} | ${subject}`);
    return {
      messageId,
      debug: {
        provider: 'mock',
        kind,
        request: { to, subject, body },
      },
    };
  }

  async sendContactMessage(name: string, email: string, message: string): Promise<SendResult> {
    return this.send(
      'hello@yairb.ch',
      'contact_message',
      `New contact message from ${name}`,
      `Name: ${name}
Email: ${email}

Message:
${message}`,
    );
  }

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_confirm_request',
      'Please confirm your booking – ILLUMINATE',
      `Hi ${booking.client_name},

You requested a 1:1 Clarity Session. Please confirm your booking by clicking the link below.

  Date & time : ${fmt(booking.starts_at)}
  Address     : ${booking.address_line}

Confirm your booking:
${confirmUrl}

This link expires in 60 minutes. If you did not request this booking, you can ignore this email.`,
    );
  }

  async sendBookingPaymentDue(booking: Booking, payUrl: string, manageUrl: string): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_payment_due',
      'Your session is reserved – payment due',
      `Hi ${booking.client_name},

Your 1:1 Clarity Session is confirmed and your slot is reserved. Please complete payment to secure it.

  Date & time  : ${fmt(booking.starts_at)}
  Address      : ${booking.address_line}
  Payment due  : ${booking.payment_due_at ? fmt(booking.payment_due_at) : 'before the session'}

Pay now:
${payUrl}

Manage your booking (cancel / reschedule):
${manageUrl}`,
    );
  }

  async sendBookingConfirmation(booking: Booking, manageUrl: string, invoiceUrl: string | null): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_confirmation',
      'Your session is confirmed – ILLUMINATE',
      `Hi ${booking.client_name},

Your 1:1 Clarity Session is confirmed. See you soon!

  Date & time : ${fmt(booking.starts_at)}
  Address     : ${booking.address_line}
  Map         : ${booking.maps_url}
${invoiceUrl ? `\n  Invoice     : ${invoiceUrl}\n` : ''}
Manage your booking (cancel / reschedule):
${manageUrl}`,
    );
  }

  async sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_payment_reminder',
      'Reminder: payment due for your session',
      `Hi ${booking.client_name},

This is a reminder that payment for your upcoming session is due.

  Date & time  : ${fmt(booking.starts_at)}
  Payment due  : ${booking.payment_due_at ? fmt(booking.payment_due_at) : 'soon'}

Pay now:
${payUrl}`,
    );
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_reminder_24h',
      'Your session is tomorrow – ILLUMINATE',
      `Hi ${booking.client_name},

A reminder that your 1:1 Clarity Session is tomorrow.

  Date & time : ${fmt(booking.starts_at)}
  Address     : ${booking.address_line}
  Map         : ${booking.maps_url}

Manage your booking:
${manageUrl}`,
    );
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_followup',
      'Did you mean to book a session?',
      `Hi ${booking.client_name},

We noticed you started a booking for a 1:1 Clarity Session but haven't confirmed yet.

  Date & time : ${fmt(booking.starts_at)}

Complete your booking:
${confirmUrl}`,
    );
  }

  async sendBookingCancellation(booking: Booking): Promise<SendResult> {
    return this.send(
      booking.client_email,
      'booking_cancellation',
      'Your booking has been cancelled',
      `Hi ${booking.client_name},

Your 1:1 Clarity Session on ${fmt(booking.starts_at)} has been cancelled.

If you'd like to rebook, visit the website anytime.`,
    );
  }

  async sendRegistrationConfirmRequest(
    registration: EventRegistration,
    event: Event,
    confirmUrl: string,
  ): Promise<SendResult> {
    return this.send(
      registration.primary_email,
      'registration_confirm_request',
      `Please confirm your spot – ${event.title}`,
      `Hi ${registration.primary_name},

You registered for an ILLUMINATE Evening. Please confirm your spot by clicking the link below.

  Event       : ${event.title}
  Date & time : ${fmt(event.starts_at)}
  Address     : ${event.address_line}
  Attendees   : ${registration.attendee_count}

Confirm your registration:
${confirmUrl}

This link expires in 15 minutes.`,
    );
  }

  async sendRegistrationConfirmation(
    registration: EventRegistration,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
  ): Promise<SendResult> {
    return this.send(
      registration.primary_email,
      'registration_confirmation',
      `You're registered – ${event.title}`,
      `Hi ${registration.primary_name},

You're confirmed for the ILLUMINATE Evening. See you there!

  Event       : ${event.title}
  Date & time : ${fmt(event.starts_at)}
  Address     : ${event.address_line}
  Map         : ${event.maps_url}
  Attendees   : ${registration.attendee_count}
${invoiceUrl ? `\n  Invoice     : ${invoiceUrl}\n` : ''}
Manage your registration (cancel):
${manageUrl}`,
    );
  }

  async sendRegistrationReminder24h(
    registration: EventRegistration,
    event: Event,
    manageUrl: string,
  ): Promise<SendResult> {
    return this.send(
      registration.primary_email,
      'registration_reminder_24h',
      `Tomorrow: ${event.title} – ILLUMINATE`,
      `Hi ${registration.primary_name},

A reminder that the ILLUMINATE Evening is tomorrow.

  Event       : ${event.title}
  Date & time : ${fmt(event.starts_at)}
  Address     : ${event.address_line}
  Map         : ${event.maps_url}

Manage your registration:
${manageUrl}`,
    );
  }

  async sendRegistrationFollowup(
    registration: EventRegistration,
    event: Event,
    actionUrl: string,
  ): Promise<SendResult> {
    return this.send(
      registration.primary_email,
      'registration_followup',
      `Still interested in ${event.title}?`,
      `Hi ${registration.primary_name},

We noticed your registration for ${event.title} (${fmt(event.starts_at)}) is still pending confirmation.

Complete your registration:
${actionUrl}`,
    );
  }
}
