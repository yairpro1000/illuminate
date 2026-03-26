import { Resend } from 'resend';
import {
  EmailProviderError,
  type CancellationEmailOptions,
  type ConfirmationEmailOptions,
  type RefundConfirmationEmailInput,
} from './interface.js';
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
const DEFAULT_SITE_URL = 'https://letsilluminate.co';
const EMAIL_HERO_IMAGE_URL = 'https://yairb.ch/img/ILLUMINATE_hero.png';
function sanitizeSiteUrl(siteUrl?: string | null): string {
  return String(siteUrl || DEFAULT_SITE_URL).replace(/\/+$/g, '');
}

function siteUrlFromKnownLink(link?: string | null): string {
  if (!link) return DEFAULT_SITE_URL;
  try {
    return sanitizeSiteUrl(new URL(link).origin);
  } catch {
    return DEFAULT_SITE_URL;
  }
}

function contactPageUrl(siteUrl?: string | null): string {
  return `${sanitizeSiteUrl(siteUrl)}/contact.html`;
}

function sessionsPageUrl(siteUrl?: string | null): string {
  return `${sanitizeSiteUrl(siteUrl)}/sessions.html`;
}

function eventsPageUrl(siteUrl?: string | null): string {
  return `${sanitizeSiteUrl(siteUrl)}/evenings.html`;
}

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

function sessionSubjectDate(booking: Booking): string {
  return fmtSubjectDate(booking.starts_at, booking.timezone);
}

function eventSubjectTitle(event: Event): string {
  return event.title.trim();
}

function bookingSubjectContext(booking: Booking): string {
  return `on ${sessionSubjectDate(booking)}`;
}

function eventBookingUrl(eventId: string | null | undefined, siteUrl?: string | null): string {
  return eventId ? eventsPageUrl(siteUrl) : sessionsPageUrl(siteUrl);
}

function bookingConfirmationSubject(
  booking: Booking,
  options: ConfirmationEmailOptions = {},
): string {
  if (options.rescheduled) {
    return `Your session has been rescheduled to ${fmtSubjectDate(booking.starts_at, booking.timezone)}`;
  }
  const isPendingPayment = options.paymentSettled === false && Boolean(options.paymentDueAt);
  return (options.paymentSettled === false || isPendingPayment)
    ? `Your session on ${fmtSubjectDate(booking.starts_at, booking.timezone)} is confirmed`
    : `Your session on ${fmtSubjectDate(booking.starts_at, booking.timezone)} is confirmed and paid`;
}

const ONLINE_SESSION_FOLLOWUP_NOTE = 'For online sessions, a video conference link will be sent at the day of the session.';

function bookingConfirmationBody(
  booking: Booking,
  manageUrl: string,
  invoiceUrl: string | null,
  payUrl: string | null | undefined,
  policyText: string,
  options: ConfirmationEmailOptions = {},
): string {
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  const receiptUrl = options.paymentSettled === false ? null : options.receiptUrl ?? null;
  if (isPendingPayment) {
    const paymentDueLabel = options.paymentDueAt
      ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
      : null;
    const lines = [
      `Hi ${clientName(booking)},`,
      '',
      options.rescheduled
        ? `Your session has been rescheduled, and payment is still pending for ${sessionLabel(booking)}.`
        : `Your session booking has been received, and payment is still pending for ${sessionLabel(booking)}.`,
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
      '',
      ONLINE_SESSION_FOLLOWUP_NOTE,
    ];
    return lines.filter((line): line is string => line !== null).join('\n');
  }

  const calendarUrl = buildGoogleCalendarTemplateUrl({
    title: sessionLabel(booking),
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    timezone: booking.timezone,
    location: booking.address_line ?? '',
    description: [
      `${sessionLabel(booking)} with Yair Benharroch.`,
      booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n'),
  });
  const lines = [
    `Hi ${clientName(booking)},`,
    '',
    options.rescheduled
      ? 'Your session has been rescheduled.'
      : options.paymentSettled === false
        ? 'Your session is confirmed.'
        : 'Your session is confirmed and payment has been settled.',
    '',
    `Session: ${sessionLabel(booking)}`,
    `Date: ${fmtBodyDate(booking.starts_at, booking.timezone)}`,
    `Time: ${fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone)}`,
    `Location: ${booking.address_line}`,
    booking.maps_url ? `Map: ${booking.maps_url}` : null,
    booking.meeting_link ? `Join Google Meet: ${booking.meeting_link}` : null,
    `Add to calendar: ${calendarUrl}`,
    '',
    'Need to reschedule or cancel?',
    `Manage booking: ${manageUrl}`,
    payUrl ? `Complete payment: ${payUrl}` : null,
    invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
    receiptUrl ? `Receipt: ${receiptUrl}` : null,
    '',
    ONLINE_SESSION_FOLLOWUP_NOTE,
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
    <img class="header__logo" src="${EMAIL_HERO_IMAGE_URL}" alt="ILLUMINATE by Yair Benharroch" />
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

function eventDetailRows(
  booking: Booking,
  event: Event,
  options: {
    includeMap?: boolean;
    includeMeetingLink?: boolean;
    includeCalendar?: boolean;
  } = {},
): Array<[string, string]> {
  const calendarUrl = buildGoogleCalendarTemplateUrl({
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timezone: event.timezone,
    location: event.address_line ?? booking.address_line ?? '',
    description: [
      `${event.title} with Yair Benharroch.`,
      booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n'),
  });
  const rows: Array<[string, string]> = [
    ['Event', `<strong>${esc(event.title)}</strong>`],
    ['Date', esc(fmtBodyDate(event.starts_at, event.timezone))],
    ['Time', esc(fmtBodyTimeRange(event.starts_at, event.ends_at, event.timezone))],
    ['Location', esc(event.address_line ?? booking.address_line ?? '')],
  ];

  if (options.includeMap && event.maps_url) {
    rows.push(['Map', `<a href="${esc(event.maps_url)}">Open in Maps</a>`]);
  }
  if (options.includeMeetingLink && booking.meeting_link) {
    rows.push(['Google Meet', `<a href="${esc(booking.meeting_link)}">Join Google Meet</a>`]);
  }
  if (options.includeCalendar) {
    rows.push(['Calendar', `<a href="${esc(calendarUrl)}">Add to Google Calendar</a>`]);
  }

  return rows;
}

function eventDetailTextLines(
  booking: Booking,
  event: Event,
  options: {
    includeMap?: boolean;
    includeMeetingLink?: boolean;
    includeCalendar?: boolean;
  } = {},
): string[] {
  const calendarUrl = buildGoogleCalendarTemplateUrl({
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timezone: event.timezone,
    location: event.address_line ?? booking.address_line ?? '',
    description: [
      `${event.title} with Yair Benharroch.`,
      booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n'),
  });
  const lines = [
    `Date: ${fmtBodyDate(event.starts_at, event.timezone)}`,
    `Time: ${fmtBodyTimeRange(event.starts_at, event.ends_at, event.timezone)}`,
    `Location: ${event.address_line ?? booking.address_line ?? ''}`,
  ];

  if (options.includeMap && event.maps_url) {
    lines.push(`Map: ${event.maps_url}`);
  }
  if (options.includeMeetingLink && booking.meeting_link) {
    lines.push(`Join Google Meet: ${booking.meeting_link}`);
  }
  if (options.includeCalendar) {
    lines.push(`Add to calendar: ${calendarUrl}`);
  }

  return lines;
}

function bookingPolicyHtml(policyText: string, siteUrl?: string | null): string {
  const contactUrl = contactPageUrl(siteUrl);
  const lines = policyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [title, firstRule, secondRule, thirdRule] = lines;
  const linkedThirdRule = String(thirdRule || '')
    .split(/(contact)/gi)
    .map((part) => part.toLowerCase() === 'contact'
      ? `<a href="${esc(contactUrl)}">contact</a>`
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
  const siteUrl = siteUrlFromKnownLink(manageUrl);
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  const receiptUrl = options.paymentSettled === false ? null : options.receiptUrl ?? null;
  const paymentMethodLabel = options.paymentMethodLabel ?? null;
  const paymentMethodMessage = options.paymentMethodMessage ?? null;
  const optionalOnlinePaymentMessage = options.optionalOnlinePaymentMessage ?? null;
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
      <p>${options.rescheduled
        ? `Your session has been rescheduled, and payment is still pending for<br /><strong style="color:#4fc3d8;">${esc(sessionLabel(booking))}</strong>`
        : `Your session booking has been received, and payment is still pending for<br /><strong style="color:#4fc3d8;">${esc(sessionLabel(booking))}</strong>`}</p>
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">${paymentDueLabel
        ? `Please complete payment by <strong style="color:#4fc3d8;">${esc(paymentDueLabel)}</strong>, which is 24 hours before your session.`
        : 'Please complete payment before your session.'}</p>
      ${payUrl ? `<p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>` : ''}
      <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
      <p style="font-size:14px;color:#88abb5;">${esc(ONLINE_SESSION_FOLLOWUP_NOTE)}</p>
    `;
    return htmlLayout(body);
  }

  const calendarUrl = buildGoogleCalendarTemplateUrl({
    title: sessionLabel(booking),
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    timezone: booking.timezone,
    location: booking.address_line ?? '',
    description: [
      `${sessionLabel(booking)} with Yair Benharroch.`,
      booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n'),
  });
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
  rows.push(['Calendar', `<a href="${esc(calendarUrl)}">Add to Google Calendar</a>`]);

  const extraLinks = [
    invoiceUrl ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>` : '',
    payUrl ? `<p class="secondary-link"><a href="${esc(payUrl)}">Complete payment &rarr;</a></p>` : '',
    receiptUrl ? `<p class="secondary-link"><a href="${esc(receiptUrl)}">View receipt &rarr;</a></p>` : '',
  ].join('');

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>${options.rescheduled
      ? 'Your session has been rescheduled.'
      : options.paymentSettled === false
        ? 'Your session is confirmed.'
        : 'Your session is confirmed and payment has been settled.'}</p>
    ${detailBlock(rows)}
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${extraLinks}
    <p style="font-size:14px;color:#88abb5;">${esc(ONLINE_SESSION_FOLLOWUP_NOTE)}</p>
    ${bookingPolicyHtml(policyText, siteUrl)}
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
  return buildGoogleCalendarTemplateUrl({
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timezone: event.timezone,
    location: event.address_line ?? '',
    description: '',
  });
}

function buildGoogleCalendarTemplateUrl(input: {
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string;
  description: string;
}): string {
  function calStr(iso: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: input.timezone,
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
    text: input.title,
    dates: `${calStr(input.startsAt)}/${calStr(input.endsAt)}`,
    ctz: input.timezone,
    details: input.description,
    location: input.location,
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
  const siteUrl = siteUrlFromKnownLink(manageUrl);
  const isPendingPayment = options.paymentSettled === false && Boolean(payUrl || invoiceUrl || options.paymentDueAt);
  const receiptUrl = options.paymentSettled === false ? null : options.receiptUrl ?? null;
  const paymentMethodLabel = options.paymentMethodLabel ?? null;
  const paymentMethodMessage = options.paymentMethodMessage ?? null;
  const optionalOnlinePaymentMessage = options.optionalOnlinePaymentMessage ?? null;
  if (isPendingPayment) {
    const paymentDueLabel = options.paymentDueAt
      ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
      : null;
    const rows = eventDetailRows(booking, event);
    if (paymentMethodLabel) {
      rows.push(['Payment method', esc(paymentMethodLabel)]);
    }
    if (paymentDueLabel) {
      rows.push(['Payment due', esc(paymentDueLabel)]);
    }
    if (invoiceUrl) {
      rows.push(['Invoice', `<a href="${esc(invoiceUrl)}">Click here</a>`]);
    }

    const body = `
      <p>Hi ${esc(clientName(booking))},</p>
      <p>Your booking for <strong style="color:#4fc3d8;">${esc(event.title)}</strong> is confirmed, and payment is still pending.</p>
      ${paymentMethodMessage ? `<p style="font-size:14px;color:#88abb5;">${esc(paymentMethodMessage)}</p>` : ''}
      ${detailBlock(rows)}
      <p style="font-size:14px;color:#88abb5;">${paymentDueLabel
        ? `Please complete payment by <strong style="color:#4fc3d8;">${esc(paymentDueLabel)}</strong>.`
        : optionalOnlinePaymentMessage
          ? esc(optionalOnlinePaymentMessage)
          : 'Please complete payment to finalize your event payment.'}</p>
      ${payUrl ? `<p><a class="btn" href="${esc(payUrl)}">Complete payment</a></p>` : ''}
      <p class="secondary-link"><a href="${esc(manageUrl)}">Manage booking &rarr;</a></p>
      <p style="font-size:14px;color:#88abb5;">${esc(ONLINE_SESSION_FOLLOWUP_NOTE)}</p>
    `;
    return htmlLayout(body);
  }

  const rows = eventDetailRows(booking, event, {
    includeMap: true,
    includeMeetingLink: true,
    includeCalendar: true,
  });

  const invoiceLine = invoiceUrl
    ? `<p class="secondary-link"><a href="${esc(invoiceUrl)}">View invoice &rarr;</a></p>`
    : '';
  const receiptLine = receiptUrl
    ? `<p class="secondary-link"><a href="${esc(receiptUrl)}">View receipt &rarr;</a></p>`
    : '';

  const body = `
    <p>Hi ${esc(clientName(booking))},</p>
    <p>${options.paymentSettled === false ? `You're confirmed for ${esc(event.title)}.` : 'You\'re confirmed and payment has been settled.'}</p>
    ${detailBlock(rows)}
    <p><a class="btn" href="${esc(manageUrl)}">Manage booking</a></p>
    ${invoiceLine}
    ${receiptLine}
    <p style="font-size:14px;color:#88abb5;">${esc(ONLINE_SESSION_FOLLOWUP_NOTE)}</p>
    ${bookingPolicyHtml(policyText, siteUrl)}
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
    `Please confirm your booking for ${sessionSubjectDate(booking)} – ILLUMINATE`,
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
    `Action needed: complete payment for your ${sessionSubjectDate(booking)} session`,
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
    `Reminder: payment due for your ${sessionSubjectDate(booking)} session`,
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
    `Your session on ${sessionSubjectDate(booking)} is tomorrow – ILLUMINATE`,
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
    `Did you mean to book your ${sessionSubjectDate(booking)} session?`,
    text,
    { html },
  );
}

export function buildBookingCancellationEmail(
  booking: Booking,
  startNewBookingUrl?: string | null,
  options: CancellationEmailOptions = {},
): BuiltEmailMessage {
  const siteUrl = siteUrlFromKnownLink(startNewBookingUrl);
  const bookingUrl = startNewBookingUrl ?? eventBookingUrl(booking.event_id, siteUrl);
  const contactUrl = contactPageUrl(siteUrl);
  const refundNotice = options.includeRefundNotice
    ? `\n\nIf a refund applies, you'll receive a separate confirmation email.`
    : '';
  const text = `Hi ${clientName(booking)},\n\nWe are sorry to see you go.\n\nYour session on ${fmt(booking.starts_at)} has been cancelled.${refundNotice}\n\nYou can always book again: ${bookingUrl}\nContact Yair: ${contactUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [
      ['Session', esc(sessionLabel(booking))],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ],
    [
      'We are sorry to see you go.',
      'Your session has been cancelled.',
      ...(options.includeRefundNotice ? ['If a refund applies, you\'ll receive a separate confirmation email.'] : []),
    ],
    'Book again',
    bookingUrl,
    [`<a href="${esc(contactUrl)}">Contact Yair &rarr;</a>`],
    'You can always',
  );
  return buildEmailMessage(
    'booking_cancellation',
    clientEmail(booking),
    `Your session ${bookingSubjectContext(booking)} has been cancelled`,
    text,
    { html },
  );
}

export function buildEventCancellationEmail(
  booking: Booking,
  event: Event,
  startNewBookingUrl?: string | null,
  options: CancellationEmailOptions = {},
): BuiltEmailMessage {
  const siteUrl = siteUrlFromKnownLink(startNewBookingUrl);
  const bookingUrl = startNewBookingUrl ?? eventBookingUrl(event.id, siteUrl);
  const contactUrl = contactPageUrl(siteUrl);
  const refundNotice = options.includeRefundNotice
    ? `\n\nIf a refund applies, you'll receive a separate confirmation email.`
    : '';
  const text = `Hi ${clientName(booking)},\n\nWe are sorry to see you go.\n\nYour event booking for ${event.title} on ${fmt(booking.starts_at)} has been cancelled.${refundNotice}\n\nYou can always book again: ${bookingUrl}\nContact Yair: ${contactUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    [
      ['Event', esc(event.title)],
      ['Date', esc(fmtBodyDate(booking.starts_at, booking.timezone))],
      ['Time', esc(fmtBodyTimeRange(booking.starts_at, booking.ends_at, booking.timezone))],
      ['Location', esc(booking.address_line ?? '')],
    ],
    [
      'We are sorry to see you go.',
      'Your event booking has been cancelled.',
      ...(options.includeRefundNotice ? ['If a refund applies, you\'ll receive a separate confirmation email.'] : []),
    ],
    'Book again',
    bookingUrl,
    [`<a href="${esc(contactUrl)}">Contact Yair &rarr;</a>`],
    'You can always',
  );
  return buildEmailMessage(
    'event_cancellation',
    clientEmail(booking),
    `Your booking for ${eventSubjectTitle(event)} has been cancelled`,
    text,
    { html },
  );
}

export function buildRefundConfirmationEmail(
  booking: Booking,
  input: RefundConfirmationEmailInput,
): BuiltEmailMessage {
  const amountLabel = `${input.currency} ${input.amount.toFixed(2)}`;
  const referenceLines = [
    input.invoiceReference ? `Invoice: ${input.invoiceReference}` : null,
    input.creditNoteUrl ? `Credit note link: ${input.creditNoteUrl}` : null,
    input.receiptUrl ? `Receipt: ${input.receiptUrl}` : null,
  ].filter(Boolean);
  const text = `Hi ${clientName(booking)},\n\n${input.explanation}\n\nBooking: ${input.subjectTitle}\nAmount: ${amountLabel}${referenceLines.length ? `\n${referenceLines.join('\n')}` : ''}`;
  const detailRows: Array<[string, string]> = [
    ['Booking', esc(input.subjectTitle)],
    ['Amount', esc(amountLabel)],
  ];
  if (input.invoiceReference) detailRows.push(['Invoice', esc(input.invoiceReference)]);
  const primaryDocumentUrl = input.receiptUrl ?? `${DEFAULT_SITE_URL}/manage.html`;
  const primaryDocumentLabel = input.receiptUrl ? 'View receipt' : 'Manage booking';
  const extraLinks = [
    input.creditNoteUrl
      ? `<a href="${esc(input.creditNoteUrl)}">View credit note &rarr;</a>`
      : null,
  ].filter((line): line is string => Boolean(line));
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    detailRows,
    [input.explanation],
    primaryDocumentLabel,
    primaryDocumentUrl,
    extraLinks,
  );
  return buildEmailMessage(
    'refund_confirmation',
    clientEmail(booking),
    `Your refund for ${input.subjectTitle}`,
    text,
    { html },
  );
}

export function buildBookingExpiredEmail(
  booking: Booking,
  startNewBookingUrl?: string | null,
): BuiltEmailMessage {
  const siteUrl = siteUrlFromKnownLink(startNewBookingUrl);
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
    startNewBookingUrl ?? siteUrl,
    [],
    startNewBookingUrl ? 'It\'s ok, you can:' : undefined,
  );
  return buildEmailMessage(
    'booking_expired',
    clientEmail(booking),
    `Your booking ${bookingSubjectContext(booking)} expired`,
    text,
    { html },
  );
}

export function buildEventConfirmRequestEmail(
  booking: Booking,
  event: Event,
  confirmUrl: string,
  confirmationWindowMinutes: number,
  options: ConfirmationEmailOptions = {},
): BuiltEmailMessage {
  const windowLabel = confirmationWindowMinutes === 1 ? '1 minute' : `${confirmationWindowMinutes} minutes`;
  const paymentMethodLabel = options.paymentMethodLabel ? `\nPayment method: ${options.paymentMethodLabel}` : '';
  const paymentMethodMessage = options.paymentMethodMessage ? `\n${options.paymentMethodMessage}` : '';
  const text = `Hi ${clientName(booking)},\n\nPlease confirm your booking for ${event.title}.${paymentMethodLabel}${paymentMethodMessage}\n\n${eventDetailTextLines(booking, event).join('\n')}\n\nYour spot is kindly held for the next ${windowLabel} before expiring.\n\nConfirm: ${confirmUrl}`;
  const introLines = ['Please confirm your spot.'];
  if (options.paymentMethodLabel) introLines.push(`Payment method: ${esc(options.paymentMethodLabel)}`);
  if (options.paymentMethodMessage) introLines.push(esc(options.paymentMethodMessage));
  introLines.push(`Your spot is kindly held for the next ${esc(windowLabel)} before expiring.`);
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    eventDetailRows(booking, event),
    introLines,
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
  const receiptUrl = paymentSettled ? options.receiptUrl ?? null : null;
  const paymentMethodLabel = options.paymentMethodLabel ?? null;
  const paymentMethodMessage = options.paymentMethodMessage ?? null;
  const optionalOnlinePaymentMessage = options.optionalOnlinePaymentMessage ?? null;
  const paymentDueLabel = options.paymentDueAt
    ? fmtBodyDateTime(options.paymentDueAt, booking.timezone)
    : null;
  const calUrl = buildGoogleCalendarUrl(event);
  const eventDetailLines = eventDetailTextLines(booking, event, {
    includeMap: paymentSettled || !isPendingPayment,
    includeMeetingLink: paymentSettled || !isPendingPayment,
    includeCalendar: paymentSettled || !isPendingPayment,
  });
  const text = paymentSettled
    ? `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}, and payment has been settled.\n\n${eventDetailLines.join('\n')}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}${receiptUrl ? `\nReceipt: ${receiptUrl}` : ''}\n\nManage: ${manageUrl}\n\n${ONLINE_SESSION_FOLLOWUP_NOTE}\n\n${policyText}`
    : options.paymentSettled === false
      ? `Hi ${clientName(booking)},\n\n${isPendingPayment ? `Your booking for ${event.title} is confirmed, and payment is still pending.` : `You're confirmed for ${event.title}.`}${paymentMethodLabel ? `\nPayment method: ${paymentMethodLabel}` : ''}${paymentMethodMessage ? `\n${paymentMethodMessage}` : ''}\n\n${eventDetailLines.join('\n')}${paymentDueLabel ? `\nPayment due: ${paymentDueLabel}` : ''}${invoiceUrl ? `\nInvoice: ${invoiceUrl}` : ''}${payUrl ? `\n\n${optionalOnlinePaymentMessage ?? 'Complete payment:'} ${payUrl}` : ''}\nManage: ${manageUrl}\n\n${ONLINE_SESSION_FOLLOWUP_NOTE}`
      : `Hi ${clientName(booking)},\n\nYou're confirmed for ${event.title}.\n\n${eventDetailLines.join('\n')}\n\nManage: ${manageUrl}\n\n${ONLINE_SESSION_FOLLOWUP_NOTE}\n\n${policyText}`;
  return buildEmailMessage(
    'event_confirmation',
    clientEmail(booking),
    paymentSettled ? `You're confirmed and paid – ${eventSubjectTitle(event)}` : `You're confirmed – ${eventSubjectTitle(event)}`,
    text,
    { html: eventConfirmationHtml(booking, event, manageUrl, invoiceUrl, payUrl, policyText, options) },
  );
}

export function buildEventReminder24hEmail(
  booking: Booking,
  event: Event,
  manageUrl: string,
): BuiltEmailMessage {
  const text = `Hi ${clientName(booking)},\n\nReminder: ${event.title} is tomorrow.\n\n${eventDetailTextLines(booking, event).join('\n')}\n\nManage: ${manageUrl}`;
  const html = simpleHtml(
    `Hi ${clientName(booking)}`,
    eventDetailRows(booking, event),
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
    eventDetailRows(booking, event),
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

  async sendBookingCancellation(
    booking: Booking,
    startNewBookingUrl?: string | null,
    options: CancellationEmailOptions = {},
  ): Promise<SendResult> {
    return this.sendEmail(buildBookingCancellationEmail(booking, startNewBookingUrl, options));
  }

  async sendEventCancellation(
    booking: Booking,
    event: Event,
    startNewBookingUrl?: string | null,
    options: CancellationEmailOptions = {},
  ): Promise<SendResult> {
    return this.sendEmail(buildEventCancellationEmail(booking, event, startNewBookingUrl, options));
  }

  async sendRefundConfirmation(booking: Booking, input: RefundConfirmationEmailInput): Promise<SendResult> {
    return this.sendEmail(buildRefundConfirmationEmail(booking, input));
  }

  async sendBookingExpired(booking: Booking, startNewBookingUrl?: string | null): Promise<SendResult> {
    return this.sendEmail(buildBookingExpiredEmail(booking, startNewBookingUrl));
  }

  async sendEventConfirmRequest(
    booking: Booking,
    event: Event,
    confirmUrl: string,
    confirmationWindowMinutes: number,
    options: ConfirmationEmailOptions = {},
  ): Promise<SendResult> {
    return this.sendEmail(buildEventConfirmRequestEmail(booking, event, confirmUrl, confirmationWindowMinutes, options));
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
