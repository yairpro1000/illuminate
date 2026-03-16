import { Resend } from 'resend';
import { EmailProviderError, type ConfirmationEmailOptions } from './interface.js';
import type { IEmailProvider, SendResult } from './interface.js';
import type { Booking, Event } from '../../types.js';

export interface EmailTransportPayload {
  from: string;
  to: string;
  subject: string;
  replyTo: string;
  text: string;
  html?: string;
}

export interface BuiltEmailMessage {
  kind: string;
  payload: EmailTransportPayload;
}

export const EMAIL_FROM = 'Illuminate Contact <bookings@letsilluminate.co>';
export const EMAIL_REPLY_TO = 'hello@yairb.ch';
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

function fmtBodyDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

function sessionLabel(booking: Booking): string {
  return booking.session_type_title?.trim() || '1:1 Session';
}

function bookingConfirmationSubject(
  booking: Booking,
  options: ConfirmationEmailOptions = {},
): string {
  const isPendingPayment = options.paymentSettled === false && Boolean(options.paymentDueAt);
  return (options.paymentSettled === false || isPendingPayment)
    ? `Your session on ${fmtSubjectDate(booking.starts_at, booking.timezone)} is confirmed`
    : `Your session on ${fmtSubjectDate(booking.starts_at, booking.timezone)} is confirmed and paid`;
}

function bookingConfirmationBody(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
  policyText: string,
  options: ConfirmationEmailOptions = {},
): string {
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  if (isPendingPayment) {
    const paymentDueLabel = options.paymentDueAt
      ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
      : null;
    const lines = [
      `Hi ${clientName(booking)},`,
      '',
      `Your session booking has been received, and payment is still pending for ${sessionLabel(booking)}.`,
      '',
      `Session: ${sessionLabel(booking)}`,
      `Date: ${fmtBodyDate(booking.starts_at, booking.timezone)}`,
      `Time: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}`,
      `Location: ${booking.address_line}`,
      paymentDueLabel ? `Payment due: ${paymentDueLabel}` : null,
      invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
      '',
      paymentDueLabel
        ? `Please complete payment by ${paymentDueLabel}, which is 24 hours before your session.`
        : 'Please complete payment before your session.',
      '',
      payUrl ? `Complete payment: ${payUrl}` : null,
      `Manage booking: ${manageUrl}`,
    ];
    return lines.filter((line): line is string => line !== null).join('\n');
  }

  const lines = [
    `Hi ${clientName(booking)},`,
    '',
    options.paymentSettled === false
      ? 'Your session is confirmed.'
      : 'Your session is confirmed and payment has been settled.',
    '',
    `Session: ${sessionLabel(booking)}`,
    `Date: ${fmtBodyDate(booking.starts_at, booking.timezone)}`,
    `Time: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}`,
    `Location: ${booking.address_line}`,
    booking.maps_url ? `Map: ${booking.maps_url}` : null,
    booking.meeting_link ? `Join Google Meet: ${booking.meeting_link}` : null,
    '',
    'A calendar invitation has been sent to you.',
    "If you don't see it, please check your spam folder.",
    '',
    'Need to reschedule or cancel?',
    `Manage booking: ${manageUrl}`,
    payUrl ? `Complete payment: ${payUrl}` : null,
    invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
    '',
    policyText,
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

function bookingPolicyHtml(policyText: string): string {
  const lines = policyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  policyText: string,
  options: ConfirmationEmailOptions = {},
): string {
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  if (isPendingPayment) {
    const paymentDueLabel = options.paymentDueAt
      ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
      : null;
    const rows: Array<[string, string]> = [
      ['Session', esc(sessionLabel(booking))],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ];
    if (paymentDueLabel) {
      rows.push(['Payment due', esc(paymentDueLabel)]);
    }
    if (invoiceUrl) {
      rows.push(['Invoice', `<a href="${esc(invoiceUrl)}">Click here</a>`]);
    }

    const body = `
      <p>Hi ${esc(clientName(booking))},</p>
      <p>Your session booking has been received, and payment is still pending for<br /><strong style="color:#4fc3d8;">${esc(sessionLabel(booking))}</strong></p>
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">${paymentDueLabel
        ? `Please complete payment by <strong style="color:#4fc3d8;">${esc(paymentDueLabel)}</strong>, which is 24 hours before your session.`
        : 'Please complete payment before your session.'}</p>
      ${payUrl ? `<p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>` : ''}
      <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
    `;
    return htmlLayout(body);
  }

  const rows: Array<[string, string]> = [
    ['Session', esc(sessionLabel(booking))],
    ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
    ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
    ['Location', esc(booking.address_line ?? '')],
  ];
  if (booking.maps_url) {
    rows.push(['Map', `<a href="${esc(booking.maps_url)}">Open in Maps</a>`]);
  }
  if (booking.meeting_link) {
    rows.push(['Google Meet', `<a href="${esc(booking.meeting_link)}">Join Google Meet</a>`]);
  }

  const extraLinks = [
    payUrl ? `<p class="secondary-link"><a href="${esc(payUrl)}">Complete payment &rarr;</a></p>` : '',
    invoiceUrl ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>` : '',
  ].join('');

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>${options.paymentSettled === false ? 'Your session is confirmed.' : 'Your session is confirmed and payment has been settled.'}</p>
    ${detailBlock(rows)}
    <p>A calendar invitation has been sent to you. If you don't see it, check your spam folder.</p>
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${extraLinks}
    ${bookingPolicyHtml(policyText)}
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
  postDetailLine?: string,
): string {
  const detail = rows && rows.length ? detailBlock(rows) : '';
  const paras = bodyLines.map(l => `<p>${l}</p>`).join('');
  const postDetail = postDetailLine ? `<p>${esc(postDetailLine)}</p>` : '';
  const extras = extraLinks.map(l => `<p class="secondary-link">${l}</p>`).join('');
  const body = `
    <p>${esc(greeting)},</p>
    ${paras}
    ${detail}
    ${postDetail}
    <p><a class="btn" href="${esc(ctaUrl)}">${esc(ctaLabel)}</a></p>
    ${extras}
  `;
  return htmlLayout(body);
}

function buildGoogleCalendarUrl(event: Event): string {
  function calStr(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: event.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(iso));
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    return `${m.year}${m.month}${m.day}T${m.hour}${m.minute}${m.second}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${calStr(event.starts_at)}/${calStr(event.ends_at)}`,
    ctz: event.timezone,
    location: event.address_line ?? '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function eventConfirmationHtml(
  booking: Booking,
  event: Event,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
  policyText: string,
  options: ConfirmationEmailOptions = {},
): string {
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  if (isPendingPayment) {
    const paymentDueLabel = options.paymentDueAt
      ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
      : null;
    const rows: Array<[string, string]> = [
      ['Event', `<strong>${esc(event.title)}</strong>`],
      ['Date &amp; time', esc(fmt(event.starts_at))],
      ['Location', esc(event.address_line ?? '')],
    ];
    if (paymentDueLabel) {
      rows.push(['Payment due', esc(paymentDueLabel)]);
    }
    if (invoiceUrl) {
      rows.push(['Invoice', `<a href="${esc(invoiceUrl)}">Click here</a>`]);
    }

    const body = `
      <p>Hi ${esc(clientName(booking))},</p>
      <p>Your booking for <strong style="color:#4fc3d8;">${esc(event.title)}</strong> is confirmed, and payment is still pending.</p>
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">${paymentDueLabel
        ? `Please complete payment by <strong style="color:#4fc3d8;">${esc(paymentDueLabel)}</strong>.`
        : 'Please complete payment to finalize your event payment.'}</p>
      ${payUrl ? `<p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>` : ''}
      <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
    `;
    return htmlLayout(body);
  }

  const rows: Array<[string, string]> = [
    ['Event', `<strong>${esc(event.title)}</strong>`],
    ['Date &amp; time', esc(fmt(event.starts_at))],
    ['Location', esc(event.address_line ?? '')],
  ];
  if (event.maps_url) {
    rows.push(['Map', `<a href="${esc(event.maps_url)}">Open in Maps</a>`]);
  }
  if (booking.meeting_link) {
    rows.push(['Google Meet', `<a href="${esc(booking.meeting_link)}">Join Google Meet</a>`]);
  }
  rows.push(['Calendar', `<a href="${esc(buildGoogleCalendarUrl(event))}">Add to Google Calendar</a>`]);

  const invoiceLine = invoiceUrl
    ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>`
    : '';

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>${options.paymentSettled === false ? `You're confirmed for ${esc(event.title)}.` : 'You\'re confirmed and payment has been settled.'}</p>
    ${detailBlock(rows)}
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${invoiceLine}
    ${bookingPolicyHtml(policyText)}
    <p style="margin-top:28px;">Looking forward to seeing you,<br /><strong style="color:#4fc3d8;">Yair</strong></p>
  `;
  return htmlLayout(body);
}

function buildEmailMessage(
  kind: string,
  to: string,
  subject: string,
  text: string,
  options?: { replyTo?: string; html?: string },
): BuiltEmailMessage {
  return {
    kind,
    payload: {
      from: EMAIL_FROM,
      to,
      subject,
      replyTo: options?.replyTo ?? EMAIL_REPLY_TO,
      text,
      ...(options?.html ? { html: options.html } : {}),
    },
  };
}

export function buildContactMessageEmail(
  name: string,
  email: string,
  message: string,
  topic?: string | null,
): BuiltEmailMessage {
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    topic ? `Topic: ${topic}` : null,
    '',
    `Message:\n${message}`,
  ].filter(Boolean).join('\n');

  return buildEmailMessage(
    'contact_message',
    'hello@yairb.ch',
    `New message from ${name}`,
    text,
    { replyTo: email },
  );
}

export function buildBookingConfirmRequestEmail(
  booking: Booking,
  confirmUrl: string,
  confirmationWindowMinutes: number,
): BuiltEmailMessage {
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

  return buildEmailMessage(
    'booking_confirm_request',
    clientEmail(booking),
    'Please confirm your booking – ILLUMINATE',
    text,
    { html: htmlLayout(body) },
  );
}

export function buildBookingPaymentDueEmail(
  booking: Booking,
  payUrl: string,
  manageUrl: string,
  paymentDueAt: string,
): BuiltEmailMessage {
  const paymentDueLabel = fmtBodyDateTime(paymentDueAt, booking.timezone);
  const text = `Hi ${clientName(booking)},\n\nYour session booking has been received, and payment is still pending for ${sessionLabel(booking)}.\n\nSession: ${sessionLabel(booking)}\nDate: ${fmtBodyDate(booking.starts_at, booking.timezone)}\nTime: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}\nLocation: ${booking.address_line}\n\nPlease complete payment by ${paymentDueLabel}, which is 24 hours before your session.\n\nComplete payment: ${payUrl}\nManage booking: ${manageUrl}`;
  const rows: Array<[string, string]> = [
    ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
    ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
    ['Location', esc(booking.address_line ?? '')],
    ['Payment due', esc(paymentDueLabel)],
  ];
  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>Your session booking has been received, and payment is still pending for<br /><strong style="color:#4fc3d8;">${esc(sessionLabel(booking))}</strong></p>
    ${detailBlock(rows)}
    <p style="font-size:14px;color:#88abb5;">Please complete payment by <strong style="color:#4fc3d8;">${esc(paymentDueLabel)}</strong>, which is 24 hours before your session.</p>
    <p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>
    <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
  `;

  return buildEmailMessage(
    'booking_payment_due',
    clientEmail(booking),
    'Action needed: complete payment before your session',
    text,
    { html: htmlLayout(body) },
  );
}

export function buildBookingConfirmationEmail(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl?: string | null,
  policyText = '',
  options: ConfirmationEmailOptions = {},
): BuiltEmailMessage {
  return buildEmailMessage(
    'booking_confirmation',
    clientEmail(booking),
    bookingConfirmationSubject(booking, options),
    bookingConfirmationBody(booking, manageUrl, invoiceUrl, payUrl, policyText, options),
    { html: bookingConfirmationHtml(booking, manageUrl, invoiceUrl, payUrl, policyText, options) },
  );
}

export function buildBookingPaymentReminderEmail(booking: Booking, payUrl: string): BuiltEmailMessage {
  const text = `Hi ${clientName(booking)},\n\nPayment reminder for your session on ${fmt(booking.starts_at)}.\n\nPay: ${payUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [['Session', esc(sessionLabel(booking))], ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))]],
    ['Payment is due for your upcoming session.'],
    'Pay now',
    payUrl,
  );
  return buildEmailMessage(
    'booking_payment_reminder',
    clientEmail(booking),
    'Reminder: payment due for your session',
    text,
    { html },
  );
}

export function buildBookingReminder24hEmail(booking: Booking, manageUrl: string): BuiltEmailMessage {
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
  return buildEmailMessage(
    'booking_reminder_24h',
    clientEmail(booking),
    'Your session is tomorrow – ILLUMINATE',
    text,
    { html },
  );
}

export function buildBookingFollowupEmail(booking: Booking, confirmUrl: string): BuiltEmailMessage {
  const text = `Hi ${clientName(booking)},\n\nYour booking is still waiting for confirmation.\n\nConfirm: ${confirmUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    null,
    ['Your booking is still waiting for your email confirmation.'],
    'Confirm booking',
    confirmUrl,
  );
  return buildEmailMessage(
    'booking_followup',
    clientEmail(booking),
    'Did you mean to book a session?',
    text,
    { html },
  );
}

export function buildBookingCancellationEmail(
  booking: Booking,
  startNewBookingUrl?: string | null,
): BuiltEmailMessage {
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
  return buildEmailMessage(
    'booking_cancellation',
    clientEmail(booking),
    'Your booking has been cancelled',
    text,
    { html },
  );
}

export function buildEventCancellationEmail(
  booking: Booking,
  event: Event,
  startNewBookingUrl?: string | null,
): BuiltEmailMessage {
  const restartLine = startNewBookingUrl ? `\nBook another event: ${startNewBookingUrl}` : '';
  const text = `Hi ${clientName(booking)},\n\nYour event booking for ${event.title} on ${fmt(booking.starts_at)} has been cancelled.${restartLine}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [
      ['Event', esc(event.title)],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ],
    [`Your event booking has been cancelled.`],
    startNewBookingUrl ? 'Book another event' : 'Back to homepage',
    startNewBookingUrl ?? 'https://yairb.ch',
  );
  return buildEmailMessage(
    'event_cancellation',
    clientEmail(booking),
    'Your event booking has been cancelled',
    text,
    { html },
  );
}

export function buildBookingExpiredEmail(
  booking: Booking,
  startNewBookingUrl?: string | null,
): BuiltEmailMessage {
  const restartLine = startNewBookingUrl ? `\nBook again: ${startNewBookingUrl}` : '';
  const text = `Hi ${clientName(booking)},\n\nYour booking request for ${fmt(booking.starts_at)} expired because it was not completed in time.\n\nThe slot has been released.${restartLine}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [
      ['Session', esc(sessionLabel(booking))],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ],
    [
      'Your booking request expired because it was not confirmed or paid in time.',
      'The slot has been released.',
    ],
    startNewBookingUrl ? 'Book again' : 'Back to homepage',
    startNewBookingUrl ?? 'https://yairb.ch',
    [],
    startNewBookingUrl ? 'It\'s ok, you can:' : undefined,
  );
  return buildEmailMessage(
    'booking_expired',
    clientEmail(booking),
    'Your booking expired',
    text,
    { html },
  );
}

export function buildEventConfirmRequestEmail(
  booking: Booking,
  event: Event,
  confirmUrl: string,
  confirmationWindowMinutes: number,
): BuiltEmailMessage {
  const windowLabel = confirmationWindowMinutes === 1 ? '1 minute' : `${confirmationWindowMinutes} minutes`;
  const text = `Hi ${clientName(booking)},\n\nPlease confirm your booking for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\n\nYour spot is kindly held for the next ${windowLabel} before expiring.\n\nConfirm: ${confirmUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))], ['Location', esc(event.address_line ?? '')]],
    ['Please confirm your spot.', `Your spot is kindly held for the next ${esc(windowLabel)} before expiring.`],
    'Confirm my spot',
    confirmUrl,
  );
  return buildEmailMessage(
    'event_confirm_request',
    clientEmail(booking),
    `Please confirm your spot – ${event.title}`,
    text,
    { html },
  );
}

export function buildEventConfirmationEmail(
  booking: Booking,
  event: Event,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl?: string | null,
  policyText = '',
  options: ConfirmationEmailOptions = {},
): BuiltEmailMessage {
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  const paymentSettled = !isPendingPayment && options.paymentSettled !== false;
  const paymentDueLabel = options.paymentDueAt
    ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
    : null;
  const calUrl = buildGoogleCalendarUrl(event);
  const text = paymentSettled
    ? `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}, and payment has been settled.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\nMap: ${event.maps_url}${booking.meeting_link ? `\nJoin Google Meet: ${booking.meeting_link}` : ''}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}\nAdd to calendar: ${calUrl}\n\nManage: ${manageUrl}\n\n${policyText}`
    : options.paymentSettled === false
      ? `Hi ${clientName(booking)},\n\n${isPendingPayment ? `Your booking for ${event.title} is confirmed, and payment is still pending.` : `You're confirmed for ${event.title}.`}\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}${paymentDueLabel ? `\nPayment due: ${paymentDueLabel}` : ''}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}${!isPendingPayment ? `\nAdd to calendar: ${calUrl}` : ''}${payUrl ? `\n\nComplete payment: ${payUrl}` : ''}\nManage: ${manageUrl}`
      : `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}.\n\nDate & time: ${fmt(event.starts_at)}\nAddress: ${event.address_line}\nMap: ${event.maps_url}${booking.meeting_link ? `\nJoin Google Meet: ${booking.meeting_link}` : ''}\nAdd to calendar: ${calUrl}\n\nManage: ${manageUrl}\n\n${policyText}`;
  return buildEmailMessage(
    'event_confirmation',
    clientEmail(booking),
    paymentSettled ? `You're confirmed and paid – ${event.title}` : `You're confirmed – ${event.title}`,
    text,
    { html: eventConfirmationHtml(booking, event, manageUrl, invoiceUrl, payUrl, policyText, options) },
  );
}

export function buildEventReminder24hEmail(
  booking: Booking,
  event: Event,
  manageUrl: string,
): BuiltEmailMessage {
  const text = `Hi ${clientName(booking)},\n\nReminder: ${event.title} is tomorrow at ${fmt(event.starts_at)}.\n\nManage: ${manageUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))], ['Location', esc(event.address_line ?? '')]],
    ['Your event is tomorrow.'],
    'Manage booking',
    manageUrl,
  );
  return buildEmailMessage(
    'event_reminder_24h',
    clientEmail(booking),
    `Tomorrow: ${event.title} – ILLUMINATE`,
    text,
    { html },
  );
}

export function buildEventFollowupEmail(
  booking: Booking,
  event: Event,
  actionUrl: string,
): BuiltEmailMessage {
  const text = `Hi ${clientName(booking)},\n\nYour booking for ${event.title} is still pending.\n\nContinue: ${actionUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [['Event', `<strong>${esc(event.title)}</strong>`], ['Date &amp; time', esc(fmt(event.starts_at))]],
    ['Your booking is still pending.'],
    'Continue',
    actionUrl,
  );
  return buildEmailMessage(
    'event_followup',
    clientEmail(booking),
    `Still interested in ${event.title}?`,
    text,
    { html },
  );
}

export class ResendEmailProvider implements IEmailProvider {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    if (!apiKey?.trim()) {
      throw new Error('RESEND_API_KEY is not set');
    }
    this.resend = new Resend(apiKey);
  }

  private async sendEmail(message: BuiltEmailMessage): Promise<SendResult> {
    const { kind, payload } = message;
    const { to, subject, text, html, replyTo } = payload;
    try {
      console.info('[email:resend] send_attempt', JSON.stringify({
        provider: 'resend',
        kind,
        to,
        subject,
        has_html: Boolean(html),
        text_length: text.length,
        html_length: html ? html.length : 0,
        branch_taken: 'send_payload_to_resend',
        deny_reason: null,
      }));

      const { data, error } = await (this.resend.emails.send as (p: unknown) => Promise<{
        data?: { id?: string } | null;
        error?: { message: string; name?: string } | null;
      }>)(payload);

      console.info('[email:resend] send_result', JSON.stringify({
        provider: 'resend',
        kind,
        to,
        subject,
        has_html: Boolean(html),
        text_length: text.length,
        html_length: html ? html.length : 0,
        message_id: data?.id ?? null,
        error_name: error?.name ?? null,
        error_message: error?.message ?? null,
        branch_taken: error || !data?.id ? 'resend_send_failed' : 'resend_send_succeeded',
        deny_reason: error?.message ?? (!data?.id ? 'missing_message_id' : null),
      }));

      if (error || !data?.id) {
        throw new EmailProviderError(`Resend error: ${error?.message ?? 'missing message id'}`, {
          provider: 'resend',
          kind,
          response: { message_id: data?.id ?? null, error_name: error?.name ?? null },
        });
      }

      return { messageId: data.id, debug: { provider: 'resend', kind } };
    } catch (err) {
      console.info('[email:resend] send_exception', JSON.stringify({
        provider: 'resend',
        kind,
        to,
        subject,
        has_html: Boolean(html),
        text_length: text.length,
        html_length: html ? html.length : 0,
        exception: err instanceof Error ? err.message : String(err),
        branch_taken: 'resend_exception_raised',
        deny_reason: err instanceof Error ? err.message : String(err),
      }));
      if (err instanceof EmailProviderError) throw err;
      throw new EmailProviderError('Resend exception while sending email', {
        provider: 'resend',
        kind,
        exception: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendContactMessage(name: string, email: string, message: string, topic?: string | null): Promise<SendResult> {
    return this.sendEmail(buildContactMessageEmail(name, email, message, topic));
  }

  async sendBookingConfirmRequest(booking: Booking, confirmUrl: string, confirmationWindowMinutes: number): Promise<SendResult> {
    return this.sendEmail(buildBookingConfirmRequestEmail(booking, confirmUrl, confirmationWindowMinutes));
  }

  async sendBookingPaymentDue(
    booking: Booking,
    payUrl: string,
    manageUrl: string,
    paymentDueAt: string,
  ): Promise<SendResult> {
    return this.sendEmail(buildBookingPaymentDueEmail(booking, payUrl, manageUrl, paymentDueAt));
  }

  async sendBookingConfirmation(
    booking: Booking,
    manageUrl: string,
    invoiceUrl: string | null,
    payUrl?: string | null,
    policyText = '',
    options: ConfirmationEmailOptions = {},
  ): Promise<SendResult> {
    return this.sendEmail(buildBookingConfirmationEmail(booking, manageUrl, invoiceUrl, payUrl, policyText, options));
  }

  async sendBookingPaymentReminder(booking: Booking, payUrl: string): Promise<SendResult> {
    return this.sendEmail(buildBookingPaymentReminderEmail(booking, payUrl));
  }

  async sendBookingReminder24h(booking: Booking, manageUrl: string): Promise<SendResult> {
    return this.sendEmail(buildBookingReminder24hEmail(booking, manageUrl));
  }

  async sendBookingFollowup(booking: Booking, confirmUrl: string): Promise<SendResult> {
    return this.sendEmail(buildBookingFollowupEmail(booking, confirmUrl));
  }

  async sendBookingCancellation(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.sendEmail(buildBookingCancellationEmail(booking, startNewBookingUrl));
  }

  async sendEventCancellation(booking: Booking, event: Event, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.sendEmail(buildEventCancellationEmail(booking, event, startNewBookingUrl));
  }

  async sendBookingExpired(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.sendEmail(buildBookingExpiredEmail(booking, startNewBookingUrl));
  }

  async sendEventConfirmRequest(
    booking: Booking,
    event: Event,
    confirmUrl: string,
    confirmationWindowMinutes: number,
  ): Promise<SendResult> {
    return this.sendEmail(buildEventConfirmRequestEmail(booking, event, confirmUrl, confirmationWindowMinutes));
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
    return this.sendEmail(buildEventConfirmationEmail(booking, event, manageUrl, invoiceUrl, payUrl, policyText, options));
  }

  async sendEventReminder24h(booking: Booking, event: Event, manageUrl: string): Promise<SendResult> {
    return this.sendEmail(buildEventReminder24hEmail(booking, event, manageUrl));
  }

  async sendEventFollowup(booking: Booking, event: Event, actionUrl: string): Promise<SendResult> {
    return this.sendEmail(buildEventFollowupEmail(booking, event, actionUrl));
  }
}
