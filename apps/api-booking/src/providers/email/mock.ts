import { mockState } from '../mock-state.js';
import type { IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event } from '../../types.js';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function clientName(booking: Booking): string {
  return [booking.client_first_name ?? '', booking.client_last_name ?? ''].join(' ').trim() || 'there';
}

function clientEmail(booking: Booking): string {
  return booking.client_email ?? 'unknown@example.com';
}

function fmtSubjectDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  }).format(new Date(iso));
}

function fmtBodyDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(iso));
}

function fmtBodyTimeRange(startIso: string, endIso: string, timezone: string): string {
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
  const start = timeFmt.format(new Date(startIso));
  const end = timeFmt.format(new Date(endIso));
  return `${start}–${end} (${timezone})`;
}

function sessionLabel(booking: Booking): string {
  return booking.session_type_title?.trim() || '1:1 Session';
}

function bookingConfirmationSubject(booking: Booking): string {
  return `Your session on ${fmtSubjectDate(booking.starts_at, booking.timezone)} is confirmed`;
}

function bookingConfirmationBody(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
): string {
  const lines = [
    `Hi ${clientName(booking)},`,
    '',
    'Your session is confirmed.',
    '',
    `Session: ${sessionLabel(booking)}`,
    `Date: ${fmtBodyDate(booking.starts_at, booking.timezone)}`,
    `Time: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}`,
    `Location: ${booking.address_line}`,
    booking.maps_url ? `Map: ${booking.maps_url}` : null,
    '',
    'A calendar invitation has been sent to you.',
    "If you don't see it, please check your spam folder.",
    '',
    'Need to reschedule or cancel?',
    `Manage booking: ${manageUrl}`,
    payUrl ? `Complete payment: ${payUrl}` : null,
    invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
    '',
    'Looking forward to meeting you,',
    'Yair',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
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
        preview: 'omitted',
      },
    };
  }

  async sendContactMessage(name: string, email: string, message: string, topic?: string | null): Promise<SendResult> {
    const body = [
      `Name: ${name}`,
      `Email: ${email}`,
      topic ? `Topic: ${topic}` : null,
      '',
      `Message:\n${message}`,
    ].filter(Boolean).join('\n');
    return this.send('hello@yairb.ch', 'contact_message', `New message from ${name}`, body);
  }

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_confirm_request',
      'Please confirm your booking – ILLUMINATE',
      `Hi ${clientName(booking)},\n\nPlease confirm your 1:1 Clarity Session booking.\n\nDate & time: ${fmt(booking.starts_at)}\nAddress: ${booking.address_line}\n\nConfirm:\n${confirmUrl}`,
    );
  }

  async sendBookingPaymentDue(booking: Booking, payUrl: string, manageUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_payment_due',
      'Action needed: complete payment in 15 minutes',
      `Hi ${clientName(booking)},\n\nYou have not completed payment for your held slot.\n\nDate & time: ${fmt(booking.starts_at)}\nYour hold will expire in 15 minutes unless payment is completed.\n\nComplete payment: ${payUrl}\nManage booking: ${manageUrl}`,
    );
  }

  async sendBookingConfirmation(
    booking: Booking,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
  ): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_confirmation',
      bookingConfirmationSubject(booking),
      bookingConfirmationBody(booking, manageUrl, invoiceUrl, payUrl),
    );
  }

  async sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_payment_reminder',
      'Reminder: payment due for your session',
      `Hi ${clientName(booking)},\n\nPayment reminder for your session on ${fmt(booking.starts_at)}.\n\nPay: ${payUrl}`,
    );
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_reminder_24h',
      'Your session is tomorrow – ILLUMINATE',
      `Hi ${clientName(booking)},\n\nReminder: your session is tomorrow at ${fmt(booking.starts_at)}.\n\nManage: ${manageUrl}`,
    );
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'booking_followup',
      'Did you mean to book a session?',
      `Hi ${clientName(booking)},\n\nYour booking is still waiting for confirmation.\n\nConfirm: ${confirmUrl}`,
    );
  }

  async sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    const restartLine = startNewBookingUrl ? `\nStart a new booking: ${startNewBookingUrl}` : '';
    return this.send(
      clientEmail(booking),
      'booking_cancellation',
      'Your booking has been cancelled',
      `Hi ${clientName(booking)},\n\nYour session on ${fmt(booking.starts_at)} has been cancelled.${restartLine}`,
    );
  }

  async sendEventConfirmRequest(booking: Booking, event: Event, confirmUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'event_confirm_request',
      `Please confirm your spot – ${event.title}`,
      `Hi ${clientName(booking)},\n\nPlease confirm your booking for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\n\nConfirm: ${confirmUrl}`,
    );
  }

  async sendEventConfirmation(
    booking: Booking,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
  ): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'event_confirmation',
      `You're confirmed – ${event.title}`,
      `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\nMap: ${event.maps_url}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}\n\nManage: ${manageUrl}`,
    );
  }

  async sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'event_reminder_24h',
      `Tomorrow: ${event.title} – ILLUMINATE`,
      `Hi ${clientName(booking)},\n\nReminder: ${event.title} is tomorrow at ${fmt(event.starts_at)}.\n\nManage: ${manageUrl}`,
    );
  }

  async sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult> {
    return this.send(
      clientEmail(booking),
      'event_followup',
      `Still interested in ${event.title}?`,
      `Hi ${clientName(booking)},\n\nYour booking for ${event.title} is still pending.\n\nContinue: ${actionUrl}`,
    );
  }
}
