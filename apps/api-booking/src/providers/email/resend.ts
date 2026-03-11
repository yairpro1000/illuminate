import { Resend } from 'resend';
import { EmailProviderError } from './interface.js';
import type { IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event } from '../../types.js';

const EMAIL_FROM = 'Illuminate Contact <bookings@letsilluminate.co>';
const EMAIL_REPLY_TO = 'hello@yairb.ch';

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
  return booking.client_email ?? '';
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

// ── HTML helpers ──────────────────────────────────────────────────────────────

function htmlLayout(bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body { margin:0; padding:0; background:#f5f5f0; font-family:Georgia,serif; color:#1a1a1a; }
  .wrap { max-width:560px; margin:40px auto; background:#ffffff; border-radius:4px; overflow:hidden; }
  .header { background:#1a1a1a; padding:32px 40px; }
  .header h1 { margin:0; font-size:18px; letter-spacing:0.12em; text-transform:uppercase; color:#e8e0d0; font-weight:400; }
  .body { padding:36px 40px; }
  .body p { margin:0 0 16px; font-size:15px; line-height:1.65; color:#1a1a1a; }
  .detail-block { background:#f9f8f5; border-left:3px solid #c4a882; padding:20px 24px; margin:24px 0; border-radius:0 4px 4px 0; }
  .detail-block p { margin:0 0 8px; font-size:14px; }
  .detail-block p:last-child { margin:0; }
  .detail-block strong { color:#1a1a1a; }
  .btn { display:inline-block; margin-top:8px; padding:12px 28px; background:#1a1a1a; color:#e8e0d0 !important; text-decoration:none; font-size:13px; letter-spacing:0.08em; text-transform:uppercase; border-radius:2px; }
  .link-row { margin:8px 0; font-size:14px; }
  .link-row a { color:#7a5c3a; }
  .footer { padding:24px 40px; border-top:1px solid #ececec; }
  .footer p { margin:0; font-size:13px; color:#888; line-height:1.6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><h1>Illuminate</h1></div>
  <div class="body">${bodyContent}</div>
  <div class="footer"><p>Illuminate · Zürich · <a href="https://yairb.ch" style="color:#888;">yairb.ch</a></p></div>
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bookingConfirmationHtml(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
): string {
  const extraLinks = [
    payUrl ? `<p class="link-row">Complete payment: <a href="${esc(payUrl)}">${esc(payUrl)}</a></p>` : '',
    invoiceUrl ? `<p class="link-row">Invoice: <a href="${esc(invoiceUrl)}">${esc(invoiceUrl)}</a></p>` : '',
  ].join('');

  const mapsLink = booking.maps_url
    ? `<p><strong>Map:</strong> <a href="${esc(booking.maps_url)}" style="color:#7a5c3a;">Open in Maps</a></p>`
    : '';

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>Your session is confirmed.</p>
    <div class="detail-block">
      <p><strong>Session:</strong> ${esc(sessionLabel(booking))}</p>
      <p><strong>Date:</strong> ${esc(fmtBodyDate(booking.starts_at, booking.timezone))}</p>
      <p><strong>Time:</strong> ${esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))}</p>
      <p><strong>Location:</strong> ${esc(booking.address_line ?? '')}</p>
      ${mapsLink}
    </div>
    <p>A calendar invitation has been sent to you. If you don't see it, please check your spam folder.</p>
    <p>Need to reschedule or cancel?<br />
      <a class="btn" href="${esc(manageUrl)}">Manage booking</a>
    </p>
    ${extraLinks}
    <p>Looking forward to meeting you,<br /><strong>Yair</strong></p>
  `;
  return htmlLayout(body);
}

function simpleHtml(greeting: string, paragraphs: string[], ctaLabel: string, ctaUrl: string, extraLines: string[] = []): string {
  const paras = paragraphs.map(p => `<p>${esc(p)}</p>`).join('\n');
  const extras = extraLines.map(l => `<p class="link-row">${l}</p>`).join('\n');
  const body = `
    ${paras}
    <p><a class="btn" href="${esc(ctaUrl)}">${esc(ctaLabel)}</a></p>
    ${extras}
  `;
  return htmlLayout(`<p>${esc(greeting)},</p>` + body);
}

function eventConfirmationHtml(
  booking: Booking,
  event: Event,
  manageUrl: string,
  invoiceUrl: string | null,
): string {
  const invoiceLine = invoiceUrl
    ? `<p class="link-row">Invoice: <a href="${esc(invoiceUrl)}">${esc(invoiceUrl)}</a></p>`
    : '';
  const mapsLink = event.maps_url
    ? `<p><strong>Map:</strong> <a href="${esc(event.maps_url)}" style="color:#7a5c3a;">Open in Maps</a></p>`
    : '';

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>You're confirmed for <strong>${esc(event.title)}</strong>.</p>
    <div class="detail-block">
      <p><strong>Date &amp; time:</strong> ${esc(fmt(event.starts_at))}</p>
      <p><strong>Location:</strong> ${esc(event.address_line ?? '')}</p>
      ${mapsLink}
    </div>
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${invoiceLine}
    <p>Looking forward to seeing you,<br /><strong>Yair</strong></p>
  `;
  return htmlLayout(body);
}

export class ResendEmailProvider implements IEmailProvider {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    if (!apiKey?.trim()) {
      throw new Error('RESEND_API_KEY is not set');
    }
    this.resend = new Resend(apiKey);
  }

  private async sendEmail(
    to: string,
    kind: string,
    subject: string,
    text: string,
    replyTo?: string,
    html?: string,
  ): Promise<SendResult> {
    try {
      const payload: Record<string, unknown> = {
        from: EMAIL_FROM,
        to,
        subject,
        reply_to: replyTo ?? EMAIL_REPLY_TO,
        text,
        ...(html ? { html } : {}),
      };

      const { data, error } = await (this.resend.emails.send as (p: unknown) => Promise<{
        data?: { id?: string } | null;
        error?: { message: string; name?: string } | null;
      }>)(payload);

      if (error || !data?.id) {
        throw new EmailProviderError(`Resend error: ${error?.message ?? 'missing message id'}`, {
          provider: 'resend',
          kind,
          response: { message_id: data?.id ?? null, error_name: error?.name ?? null },
        });
      }

      return { messageId: data.id, debug: { provider: 'resend', kind } };
    } catch (err) {
      if (err instanceof EmailProviderError) throw err;
      throw new EmailProviderError('Resend exception while sending email', {
        provider: 'resend',
        kind,
        exception: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendContactMessage(name: string, email: string, message: string, topic?: string | null): Promise<SendResult> {
    const body = [
      `Name: ${name}`,
      `Email: ${email}`,
      topic ? `Topic: ${topic}` : null,
      '',
      `Message:\n${message}`,
    ].filter(Boolean).join('\n');

    return this.sendEmail('hello@yairb.ch', 'contact_message', `New message from ${name}`, body, email);
  }

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nPlease confirm your 1:1 session booking.\n\nDate & time: ${fmt(booking.starts_at)}\nAddress: ${booking.address_line}\n\nConfirm: ${confirmUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      ['Please confirm your 1:1 session booking.', `Date & time: ${fmt(booking.starts_at)}`, `Address: ${booking.address_line}`],
      'Confirm booking',
      confirmUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_confirm_request', 'Please confirm your booking – ILLUMINATE', text, undefined, html);
  }

  async sendBookingPaymentDue(
    booking: Booking,
    payUrl: string,
    manageUrl: string,
    expiryGraceMinutes: number,
  ): Promise<SendResult> {
    const expiryGraceLabel = `${expiryGraceMinutes} minutes`;
    const text = `Hi ${clientName(booking)},\n\nYou have not completed payment for your held slot.\n\nDate & time: ${fmt(booking.starts_at)}\nYour hold will expire in ${expiryGraceLabel} unless payment is completed.\n\nComplete payment: ${payUrl}\nManage booking: ${manageUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [
        'You have not completed payment for your held slot.',
        `Date & time: ${fmt(booking.starts_at)}`,
        `Your hold will expire in ${expiryGraceLabel} unless payment is completed.`,
      ],
      'Complete payment',
      payUrl,
      [`Manage booking: <a href="${esc(manageUrl)}">${esc(manageUrl)}</a>`],
    );
    return this.sendEmail(
      clientEmail(booking),
      'booking_payment_due',
      `Action needed: complete payment in ${expiryGraceLabel}`,
      text,
      undefined,
      html,
    );
  }

  async sendBookingConfirmation(
    booking: Booking,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
  ): Promise<SendResult> {
    return this.sendEmail(
      clientEmail(booking),
      'booking_confirmation',
      bookingConfirmationSubject(booking),
      bookingConfirmationBody(booking, manageUrl, invoiceUrl, payUrl),
      undefined,
      bookingConfirmationHtml(booking, manageUrl, invoiceUrl, payUrl),
    );
  }

  async sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nPayment reminder for your session on ${fmt(booking.starts_at)}.\n\nPay: ${payUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [`Payment reminder for your session on ${fmt(booking.starts_at)}.`],
      'Pay now',
      payUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_payment_reminder', 'Reminder: payment due for your session', text, undefined, html);
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nReminder: your session is tomorrow at ${fmt(booking.starts_at)}.\n\nManage: ${manageUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [`Reminder: your session is tomorrow at ${fmt(booking.starts_at)}.`],
      'Manage booking',
      manageUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_reminder_24h', 'Your session is tomorrow – ILLUMINATE', text, undefined, html);
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nYour booking is still waiting for confirmation.\n\nConfirm: ${confirmUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      ['Your booking is still waiting for confirmation.'],
      'Confirm booking',
      confirmUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_followup', 'Did you mean to book a session?', text, undefined, html);
  }

  async sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    const restartLine = startNewBookingUrl ? `\nStart a new booking: ${startNewBookingUrl}` : '';
    const text = `Hi ${clientName(booking)},\n\nYour session on ${fmt(booking.starts_at)} has been cancelled.${restartLine}`;
    const extraLinks = startNewBookingUrl
      ? [`Start a new booking: <a href="${esc(startNewBookingUrl)}">${esc(startNewBookingUrl)}</a>`]
      : [];
    const html = startNewBookingUrl
      ? simpleHtml(`Hi ${clientName(booking)}`, [`Your session on ${fmt(booking.starts_at)} has been cancelled.`], 'Start a new booking', startNewBookingUrl, extraLinks)
      : htmlLayout(`<p>${esc(`Hi ${clientName(booking)},`)}</p><p>${esc(`Your session on ${fmt(booking.starts_at)} has been cancelled.`)}</p><p>If you'd like to rebook, visit <a href="https://yairb.ch" style="color:#7a5c3a;">yairb.ch</a>.</p>`);
    return this.sendEmail(clientEmail(booking), 'booking_cancellation', 'Your booking has been cancelled', text, undefined, html);
  }

  async sendEventConfirmRequest(booking: Booking, event: Event, confirmUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nPlease confirm your booking for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\n\nConfirm: ${confirmUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [`Please confirm your booking for ${event.title}.`, `Date & time: ${fmt(event.starts_at)}`, `Address: ${event.address_line}`],
      'Confirm my spot',
      confirmUrl,
    );
    return this.sendEmail(clientEmail(booking), 'event_confirm_request', `Please confirm your spot – ${event.title}`, text, undefined, html);
  }

  async sendEventConfirmation(
    booking: Booking,
    event: Event,
    manageUrl: string,
    invoiceUrl: string | null,
  ): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\nMap: ${event.maps_url}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}\n\nManage: ${manageUrl}`;
    const html = eventConfirmationHtml(booking, event, manageUrl, invoiceUrl);
    return this.sendEmail(clientEmail(booking), 'event_confirmation', `You're confirmed – ${event.title}`, text, undefined, html);
  }

  async sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nReminder: ${event.title} is tomorrow at ${fmt(event.starts_at)}.\n\nManage: ${manageUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [`Reminder: ${event.title} is tomorrow at ${fmt(event.starts_at)}.`],
      'Manage booking',
      manageUrl,
    );
    return this.sendEmail(clientEmail(booking), 'event_reminder_24h', `Tomorrow: ${event.title} – ILLUMINATE`, text, undefined, html);
  }

  async sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nYour booking for ${event.title} is still pending.\n\nContinue: ${actionUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [`Your booking for ${event.title} is still pending.`],
      'Continue',
      actionUrl,
    );
    return this.sendEmail(clientEmail(booking), 'event_followup', `Still interested in ${event.title}?`, text, undefined, html);
  }
}
