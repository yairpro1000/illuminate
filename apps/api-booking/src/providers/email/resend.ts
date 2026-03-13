import { Resend } from 'resend';
import { EmailProviderError } from './interface.js';
import type { IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event } from '../../types.js';
import { getBookingPolicyText } from '../../domain/booking-effect-policy.js';

const EMAIL_FROM = 'Illuminate Contact <bookings@letsilluminate.co>';
const EMAIL_REPLY_TO = 'hello@yairb.ch';
const CONTACT_PAGE_URL = 'https://letsilluminate.co/contact.html';
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
    getBookingPolicyText(),
    '',
    'Looking forward to meeting you,',
    'Yair',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
//
// Palette (hex equivalents of the site's OKLCH tokens, email-safe):
//   #0d1820  body bg         (oklch 11% 0.022 210)
//   #111f2a  card bg         (oklch 14% 0.025 208)
//   #0a1219  header bg       (darkest)
//   #1a9db8  lake teal       (oklch 59% 0.160 200)
//   #0c7a91  lake deep       (oklch 44% 0.155 204)
//   #4fc3d8  lake light      (oklch 73% 0.130 195)
//   #ddeef2  text primary    (oklch 91% 0.015 200)
//   #88abb5  text muted      (oklch 65% 0.020 207)
//   #1d3848  border          (teal-tinted dark)
//   #dff3f7  detail bg       (very light teal — for info containers)
//   #0a3d50  detail label    (dark teal text inside light container)
//   #0d2e3e  detail value    (darkest teal text)

function htmlLayout(bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body,table,td,p,a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  body { margin:0; padding:0; background:#0d1820; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
  .wrap { max-width:560px; margin:0 auto; background:#0d1820; border-radius:12px; overflow:hidden; }
  .header { background:#0a1219; padding:0; text-align:center; font-size:0; }
  .header__logo { display:block; width:100%; max-width:100%; height:auto; }
  .body { background:#111f2a; padding:36px 40px 32px; border-left:1px solid #1d3848; border-right:1px solid #1d3848; text-align:center; }
  .body p { margin:0 0 18px; font-size:15px; line-height:1.7; color:#ddeef2; }
  .body p:last-child { margin-bottom:0; }
  .detail-block { background:#dff3f7; border-left:3px solid #1a9db8; border-radius:6px; margin:24px auto; overflow:hidden; text-align:left; max-width:400px; }
  .detail-block table { width:100%; border-collapse:collapse; }
  .detail-block td { padding:6px 20px; font-size:14px; vertical-align:bottom; line-height:1.5; }
  .detail-block tr:first-child td { padding-top:18px; }
  .detail-block tr:last-child td { padding-bottom:18px; }
  .detail-block .lbl { color:#0a5068; font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:0.07em; width:100px; padding-right:8px; white-space:nowrap; }
  .detail-block .val { color:#0d2e3e; font-weight:500; }
  .detail-block .val a { color:#0c7a91; }
  .btn { display:inline-block; margin-top:4px; padding:13px 30px; background:#1a9db8; color:#ffffff !important; text-decoration:none; font-size:14px; font-weight:600; letter-spacing:0.03em; border-radius:6px; }
  .btn:hover { background:#0c7a91; }
  .secondary-link { margin-top:12px; font-size:14px; }
  .secondary-link a { color:#4fc3d8; text-decoration:none; }
  .policy { text-align:left; max-width:420px; margin:16px auto 0; color:#88abb5; }
  .policy__title { margin:0 0 8px; color:#ddeef2; font-size:14px; line-height:1.6; }
  .policy__list { margin:0; padding-left:18px; }
  .policy__list li { margin:4px 0; font-size:14px; line-height:1.6; }
  .policy a { color:#4fc3d8; }
  .footer { background:#0a1219; padding:28px 40px; border-top:1px solid #1d3848; border-left:1px solid #1d3848; border-right:1px solid #1d3848; text-align:center; }
  .footer__brand { margin:0; font-size:12px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:#4fc3d8; }
  .footer__sub { font-weight:400; letter-spacing:0.03em; text-transform:none; color:#88abb5; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <img class="header__logo" src="https://letsilluminate.co/img/ILLUMINATE_hero.png" alt="ILLUMINATE by Yair Benharroch" />
  </div>
  <div class="body">${bodyContent}</div>
  <div class="footer"><p class="footer__brand">ILLUMINATE <span class="footer__sub">by Yair Benharroch</span></p></div>
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Renders a detail info box (light teal bg, dark teal text) from an array of [label, value] rows. */
function detailBlock(rows: Array<[string, string]>): string {
  const trs = rows.map(([label, value]) =>
    `<tr><td class="lbl">${label}</td><td class="val">${value}</td></tr>`,
  ).join('');
  return `<div class="detail-block"><table>${trs}</table></div>`;
}

function bookingPolicyHtml(): string {
  const lines = getBookingPolicyText().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [title, firstRule, secondRule, thirdRule] = lines;
  const linkedThirdRule = String(thirdRule || '')
    .split(/(contact)/gi)
    .map((part) => part.toLowerCase() === 'contact'
      ? `<a href="${esc(CONTACT_PAGE_URL)}">contact</a>`
      : esc(part))
    .join('');

  return `
    <section class="policy" aria-label="Booking policy">
      <p class="policy__title"><strong><u>${esc(title || 'Booking policy')}</u></strong></p>
      <ul class="policy__list">
        <li>${esc(firstRule || '')}</li>
        <li>${esc(secondRule || '')}</li>
        <li>${linkedThirdRule}</li>
      </ul>
    </section>
  `;
}

function bookingConfirmationHtml(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
): string {
  const rows: Array<[string, string]> = [
    ['Session', esc(sessionLabel(booking))],
    ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
    ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
    ['Location', esc(booking.address_line ?? '')],
  ];
  if (booking.maps_url) {
    rows.push(['Map', `<a href="${esc(booking.maps_url)}">Open in Maps</a>`]);
  }

  const extraLinks = [
    payUrl ? `<p class="secondary-link"><a href="${esc(payUrl)}">Complete payment &rarr;</a></p>` : '',
    invoiceUrl ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>` : '',
  ].join('');

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>Your session is confirmed.</p>
    ${detailBlock(rows)}
    <p>A calendar invitation has been sent to you. If you don't see it, check your spam folder.</p>
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${extraLinks}
    ${bookingPolicyHtml()}
    <p style="margin-top:28px;">Looking forward to meeting you,<br /><strong style="color:#4fc3d8;">Yair</strong></p>
  `;
  return htmlLayout(body);
}

/** extraLinks: pre-built HTML snippets (e.g. `<a href="…">label</a>`), each wrapped in a secondary-link paragraph. */
function simpleHtml(
  greeting: string,
  rows: Array<[string, string]> | null,
  bodyLines: string[],
  ctaLabel: string,
  ctaUrl: string,
  extraLinks: string[] = [],
): string {
  const detail = rows && rows.length ? detailBlock(rows) : '';
  const paras = bodyLines.map(l => `<p>${l}</p>`).join('');
  const extras = extraLinks.map(l => `<p class="secondary-link">${l}</p>`).join('');
  const body = `
    <p>${esc(greeting)},</p>
    ${paras}
    ${detail}
    <p><a class="btn" href="${esc(ctaUrl)}">${esc(ctaLabel)}</a></p>
    ${extras}
  `;
  return htmlLayout(body);
}

function eventConfirmationHtml(
  booking: Booking,
  event: Event,
  manageUrl: string,
  invoiceUrl: string | null,
): string {
  const rows: Array<[string, string]> = [
    ['Event', `<strong>${esc(event.title)}</strong>`],
    ['Date &amp; time', esc(fmt(event.starts_at))],
    ['Location', esc(event.address_line ?? '')],
  ];
  if (event.maps_url) {
    rows.push(['Map', `<a href="${esc(event.maps_url)}">Open in Maps</a>`]);
  }

  const invoiceLine = invoiceUrl
    ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>`
    : '';

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>You're confirmed.</p>
    ${detailBlock(rows)}
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${invoiceLine}
    ${bookingPolicyHtml()}
    <p style="margin-top:28px;">Looking forward to seeing you,<br /><strong style="color:#4fc3d8;">Yair</strong></p>
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
        replyTo: replyTo ?? EMAIL_REPLY_TO,
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

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string, confirmationWindowMinutes: number): Promise<SendResult> {
    const windowLabel = confirmationWindowMinutes === 1 ? '1 minute' : `${confirmationWindowMinutes} minutes`;
    const text = `Hi ${clientName(booking)},\n\nPlease confirm your session booking.\n\nSession: ${sessionLabel(booking)}\nDate: ${fmtBodyDate(booking.starts_at, booking.timezone)}\nTime: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}\nLocation: ${booking.address_line}\n\nThe slot is kindly held for you for the next ${windowLabel} before expiring.\n\nConfirm: ${confirmUrl}`;
    const rows: Array<[string, string]> = [
      ['Session', esc(sessionLabel(booking))],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ];
    const body = `
      <p>Hi ${esc(clientName(booking))},</p>
      <p>Please confirm your session booking.</p>
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">The slot is kindly held for you for the next <strong style="color:#4fc3d8;">${esc(windowLabel)}</strong> before expiring.</p>
      <p><a class="btn" href="${esc(confirmUrl)}">Confirm booking</a></p>
    `;
    return this.sendEmail(clientEmail(booking), 'booking_confirm_request', 'Please confirm your booking – ILLUMINATE', text, undefined, htmlLayout(body));
  }

  async sendBookingPaymentDue(
    booking: Booking,
    payUrl: string,
    manageUrl: string,
    expiryGraceMinutes: number,
  ): Promise<SendResult> {
    const expiryGraceLabel = expiryGraceMinutes === 1 ? '1 minute' : `${expiryGraceMinutes} minutes`;
    const text = `Hi ${clientName(booking)},\n\nWe noticed you haven't yet completed your payment for ${sessionLabel(booking)}.\n\nSession: ${sessionLabel(booking)}\nDate: ${fmtBodyDate(booking.starts_at, booking.timezone)}\nTime: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}\nLocation: ${booking.address_line}\n\nThe slot is kindly held for you for the next ${expiryGraceLabel} before expiring.\n\nComplete payment: ${payUrl}\nManage booking: ${manageUrl}`;
    const rows: Array<[string, string]> = [
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ];
    const body = `
      <p>Hi ${esc(clientName(booking))},</p>
      <p>We noticed you haven't yet completed your payment for<br /><strong style="color:#4fc3d8;">${esc(sessionLabel(booking))}</strong></p>
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">The slot is kindly held for you for the next <strong style="color:#4fc3d8;">${esc(expiryGraceLabel)}</strong> before expiring.</p>
      <p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>
      <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
    `;
    return this.sendEmail(clientEmail(booking), 'booking_payment_due', `Action needed: complete payment in ${expiryGraceLabel}`, text, undefined, htmlLayout(body));
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
      [['Session', esc(sessionLabel(booking))], ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))]],
      ['Payment is due for your upcoming session.'],
      'Pay now',
      payUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_payment_reminder', 'Reminder: payment due for your session', text, undefined, html);
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nReminder: your session is tomorrow at ${fmt(booking.starts_at)}.\n\nManage: ${manageUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [
        ['Session', esc(sessionLabel(booking))],
        ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
        ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
        ['Location', esc(booking.address_line ?? '')],
      ],
      ['Your session is tomorrow.'],
      'Manage booking',
      manageUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_reminder_24h', 'Your session is tomorrow – ILLUMINATE', text, undefined, html);
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nYour booking is still waiting for confirmation.\n\nConfirm: ${confirmUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      null,
      ['Your booking is still waiting for your email confirmation.'],
      'Confirm booking',
      confirmUrl,
    );
    return this.sendEmail(clientEmail(booking), 'booking_followup', 'Did you mean to book a session?', text, undefined, html);
  }

  async sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    const restartLine = startNewBookingUrl ? `\nStart a new booking: ${startNewBookingUrl}` : '';
    const text = `Hi ${clientName(booking)},\n\nYour session on ${fmt(booking.starts_at)} has been cancelled.${restartLine}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [
        ['Session', esc(sessionLabel(booking))],
        ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
        ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
        ['Location', esc(booking.address_line ?? '')],
      ],
      ['Your session has been cancelled.'],
      startNewBookingUrl ? 'Book a new session' : 'Back to homepage',
      startNewBookingUrl ?? 'https://yairb.ch',
    );
    return this.sendEmail(clientEmail(booking), 'booking_cancellation', 'Your booking has been cancelled', text, undefined, html);
  }

  async sendEventConfirmRequest(booking: Booking, event: Event, confirmUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nPlease confirm your booking for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\n\nConfirm: ${confirmUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))], ['Location', esc(event.address_line ?? '')]],
      ['Please confirm your spot.'],
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
    const text = `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\nMap: ${event.maps_url}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}\n\nManage: ${manageUrl}\n\n${getBookingPolicyText()}`;
    const html = eventConfirmationHtml(booking, event, manageUrl, invoiceUrl);
    return this.sendEmail(clientEmail(booking), 'event_confirmation', `You're confirmed – ${event.title}`, text, undefined, html);
  }

  async sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nReminder: ${event.title} is tomorrow at ${fmt(event.starts_at)}.\n\nManage: ${manageUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))], ['Location', esc(event.address_line ?? '')]],
      ['Your event is tomorrow.'],
      'Manage booking',
      manageUrl,
    );
    return this.sendEmail(clientEmail(booking), 'event_reminder_24h', `Tomorrow: ${event.title} – ILLUMINATE`, text, undefined, html);
  }

  async sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult> {
    const text = `Hi ${clientName(booking)},\n\nYour booking for ${event.title} is still pending.\n\nContinue: ${actionUrl}`;
    const html = simpleHtml(
      `Hi ${clientName(booking)}`,
      [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))]],
      ['Your booking is still pending.'],
      'Continue',
      actionUrl,
    );
    return this.sendEmail(clientEmail(booking), 'event_followup', `Still interested in ${event.title}?`, text, undefined, html);
  }
}
