/* ============================================================
   ILLUMINATE — Booking flow
   Flow A: 1:1 session booking (calendar → slot → details → payment → review → done)
   Flow B: Event registration  (details → review → done)

   Depends on: api.js (loaded first in book.html)
   ============================================================ */

'use strict';

/* ══════════════════════════════════════════════════════════
   1. BOOKING CONTEXT — parsed from URL query params
   ══════════════════════════════════════════════════════════ */

function parseBookingContext() {
  const p = new URLSearchParams(window.location.search);
  const source = p.get('source') || 'generic';

  if (source === 'event') {
    return {
      source:       'event',
      eventSlug:    p.get('eventSlug')    || '',
      eventTitle:   p.get('eventTitle')   || 'ILLUMINATE Evening',
      eventDate:    p.get('eventDate')    || '',
      eventDisplay: p.get('eventDisplay') || '',
      isPaid:        p.get('isPaid') === 'true',
      price:         Number(p.get('price') || 0),  // price in cents
      eventStart:    p.get('eventStart')    || '',
      eventEnd:      p.get('eventEnd')      || '',
      eventLocation: p.get('eventLocation') || '',
    };
  }

  return { source: 'generic' };
}

const CTX = parseBookingContext();

// Analytics — log booking context on page load
console.log('[Book] Booking context:', CTX);
console.log(
  '[Book] Source:',
  CTX.source === 'event'
    ? 'event — ' + CTX.eventTitle + ' (' + CTX.eventDate + ')'
    : 'generic (1:1 booking)'
);

/* ══════════════════════════════════════════════════════════
   2. STATE
   ══════════════════════════════════════════════════════════ */

const S = {
  // Shared
  step: 1,
  name:  '',
  email: '',
  phone: '',
  errors: {},
  submitting: false,

  // Flow A — Calendar
  calYear:       new Date().getFullYear(),
  calMonth:      new Date().getMonth(),  // 0-indexed
  calViewDate:   null,                   // null = month view; Date obj = day slot view
  slots:         [],
  slotsByDate:   {},                     // 'YYYY-MM-DD' → [slot, ...]
  availableDates: new Set(),
  selectedSlot:  null,                   // {start, end}

  // Flow A — Payment
  paymentMethod: null,                   // 'pay-now' | 'pay-later'

  // Flow B — Attendees
  additionalAttendees: [],               // array of name strings (up to 4)

  // Payment simulation (paid flows only)
  paymentResult: null,                   // null | 'success' | 'failure'
};

/* ══════════════════════════════════════════════════════════
   3. HELPERS
   ══════════════════════════════════════════════════════════ */

function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function formatTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDateLong(isoStr) {
  const d = new Date(isoStr.slice(0, 10) + 'T12:00:00');
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatDateShort(isoStr) {
  const d = new Date(isoStr.slice(0, 10) + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateFields(fields) {
  const errs = {};
  if (fields.name && !S.name.trim())
    errs.name = 'Please enter your name.';
  if (fields.email) {
    if (!S.email.trim())              errs.email = 'Please enter your email.';
    else if (!EMAIL_RE.test(S.email)) errs.email = 'Please enter a valid email address.';
  }
  if (fields.phone) {
    if (!S.phone.trim())
      errs.phone = 'Phone number is required for this registration.';
    else if (S.phone.replace(/\D/g, '').length < 7)
      errs.phone = 'Please enter a valid phone number.';
  }
  if (fields.paymentMethod && !S.paymentMethod)
    errs.paymentMethod = 'Please choose a payment option.';
  return errs;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/* ══════════════════════════════════════════════════════════
   4. RENDER ENGINE
   ══════════════════════════════════════════════════════════ */

function render() {
  const app = document.getElementById('booking-app');
  if (!app) return;
  app.innerHTML = buildShell();
  attachListeners();
}

function buildShell() {
  const isEvent    = CTX.source === 'event';
  const totalSteps = isEvent ? 3 : 5;
  const isFinal    = (isEvent && S.step === 3) || (!isEvent && S.step === 5);

  return `
    <div class="booking-card">
      ${!isFinal ? `
        <header class="booking-header">
          <h1 class="booking-title">${isEvent ? 'Register' : 'Book a Session'}</h1>
          ${isEvent ? buildEventBanner() : ''}
          ${buildProgress(totalSteps)}
        </header>
      ` : ''}
      <div class="booking-body">
        ${isEvent ? buildEventFlow() : buildBookingFlow()}
      </div>
    </div>
  `;
}

function buildEventBanner() {
  return `
    <div class="event-banner">
      <span class="event-banner__icon" aria-hidden="true">◈</span>
      <div>
        <p class="event-banner__title">${escHtml(CTX.eventTitle)}</p>
        ${CTX.eventDisplay
          ? `<p class="event-banner__date">${escHtml(CTX.eventDisplay)}</p>`
          : ''}
      </div>
    </div>
  `;
}

function buildProgress(total) {
  let html = '<nav class="booking-progress" aria-label="Booking steps">';
  for (let i = 1; i <= total; i++) {
    const done    = i < S.step;
    const current = i === S.step;
    html += `
      <div class="progress-step ${done ? 'progress-step--done' : current ? 'progress-step--current' : ''}"
           aria-label="Step ${i}${done ? ', completed' : current ? ', current' : ''}">
        <span class="progress-step__dot">${done ? '✓' : i}</span>
      </div>
      ${i < total ? `<div class="progress-line ${done ? 'progress-line--done' : ''}"></div>` : ''}
    `;
  }
  html += '</nav>';
  return html;
}

/* ── Step routing ─────────────────────────────────────────── */

function buildBookingFlow() {
  switch (S.step) {
    case 1: return buildCalendar();
    case 2: return buildContactForm(false);
    case 3: return buildPaymentChoice();
    case 4: return buildBookingReview();
    case 5: return buildConfirmation();
    default: return '';
  }
}

function buildEventFlow() {
  switch (S.step) {
    case 1: return buildEventContactForm();
    case 2: return buildEventReview();
    case 3: return buildConfirmation();
    default: return '';
  }
}

/* ══════════════════════════════════════════════════════════
   5. STEP RENDERERS
   ══════════════════════════════════════════════════════════ */

/* ── Calendar month view (Flow A, Step 1) ───────────────── */

function buildCalendar() {
  if (S.calViewDate) return buildDaySlots();

  const year  = S.calYear;
  const month = S.calMonth;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const monthName = firstDay.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  // Monday-first grid offset (Mon=0, Tue=1, …, Sun=6)
  const startOffset = (firstDay.getDay() + 6) % 7;

  const now = new Date();
  const canPrev = year > now.getFullYear()
    || (year === now.getFullYear() && month > now.getMonth());
  const maxDate = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const canNext = new Date(year, month + 1, 1) < maxDate;

  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  let cells = '';

  // Leading empty cells
  for (let i = 0; i < startOffset; i++) {
    cells += '<div class="cal-day cal-day--empty" aria-hidden="true"></div>';
  }

  // Day cells
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date = new Date(year, month, d);
    date.setHours(0, 0, 0, 0);
    const ymd         = toYMD(date);
    const isPast      = date < today;
    const isAvailable = !isPast && S.availableDates.has(ymd);
    const isToday     = ymd === toYMD(today);

    const cls = [
      'cal-day',
      isPast      ? 'cal-day--past'      : '',
      isToday     ? 'cal-day--today'     : '',
      isAvailable ? 'cal-day--available' : '',
    ].filter(Boolean).join(' ');

    const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      + (isAvailable ? ', available' : '');

    cells += `
      <button class="${cls}" ${!isAvailable ? 'disabled' : ''} data-date="${ymd}"
              aria-label="${label}" ${isAvailable ? '' : 'tabindex="-1"'}>
        <span class="cal-day__num">${d}</span>
        ${isAvailable ? '<span class="cal-day__dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }

  return `
    <div class="cal-step">
      <p class="step-eyebrow">Choose a date</p>
      <div class="calendar">
        <div class="cal-header">
          <button class="cal-nav" data-cal-prev aria-label="Previous month" ${!canPrev ? 'disabled' : ''}>‹</button>
          <span class="cal-month-name">${monthName}</span>
          <button class="cal-nav" data-cal-next aria-label="Next month"     ${!canNext ? 'disabled' : ''}>›</button>
        </div>
        <div class="cal-grid" role="grid" aria-label="${monthName}">
          ${DAYS.map(d => `<div class="cal-weekday" role="columnheader" aria-label="${d}">${d}</div>`).join('')}
          ${cells}
        </div>
      </div>
      <p class="cal-legend"><span class="cal-legend__dot" aria-hidden="true"></span>Available dates</p>
    </div>
  `;
}

/* ── Calendar day view — time slot list ─────────────────── */

function buildDaySlots() {
  const date    = S.calViewDate;
  const ymd     = toYMD(date);
  const daySlots = S.slotsByDate[ymd] || [];
  const dateLabel = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const slotBtns = daySlots.map(slot => {
    const isSelected = S.selectedSlot && S.selectedSlot.start === slot.start;
    return `
      <button class="time-slot ${isSelected ? 'time-slot--selected' : ''}"
              data-slot='${JSON.stringify(slot)}'
              aria-pressed="${isSelected}">
        ${formatTime(slot.start)}
      </button>
    `;
  }).join('');

  return `
    <div class="cal-step">
      <button class="cal-back-btn" data-cal-back-month>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Back to calendar
      </button>
      <p class="step-eyebrow">${dateLabel}</p>
      <div class="time-slots" role="group" aria-label="Available times">
        ${slotBtns}
      </div>
      ${S.selectedSlot ? `
        <div class="step-footer">
          <div></div>
          <button class="btn btn-primary" data-next>Continue →</button>
        </div>
      ` : ''}
    </div>
  `;
}

/* ── Contact form (Flow A, Step 2) ──────────────────────── */

function buildContactForm(requirePhone) {
  const slotLine = S.selectedSlot
    ? `<p class="selected-slot-chip">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style="vertical-align:-.15em">
          <rect x=".75" y="1.75" width="11.5" height="10.5" rx="1.75" stroke="currentColor" stroke-width="1.2"/>
          <path d="M.75 5.5h11.5M4.5.75v2M8.5.75v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        ${formatDateShort(S.selectedSlot.start)} · ${formatTime(S.selectedSlot.start)}
      </p>`
    : '';

  return `
    <div class="form-step">
      ${slotLine}
      <p class="step-eyebrow">Your details</p>

      <div class="form-group">
        <label class="form-label" for="f-name">Name <span class="required-star" aria-hidden="true">*</span></label>
        <input id="f-name" class="form-input ${S.errors.name ? 'form-input--error' : ''}"
               type="text" placeholder="Your full name" autocomplete="name"
               value="${escHtml(S.name)}" data-field="name" />
        ${S.errors.name ? `<p class="form-error" role="alert">${escHtml(S.errors.name)}</p>` : ''}
      </div>

      <div class="form-group">
        <label class="form-label" for="f-email">Email <span class="required-star" aria-hidden="true">*</span></label>
        <input id="f-email" class="form-input ${S.errors.email ? 'form-input--error' : ''}"
               type="email" placeholder="your@email.com" autocomplete="email"
               value="${escHtml(S.email)}" data-field="email" />
        ${S.errors.email ? `<p class="form-error" role="alert">${escHtml(S.errors.email)}</p>` : ''}
      </div>

      <div class="form-group">
        <label class="form-label" for="f-phone">
          Phone
          ${requirePhone
            ? '<span class="required-star" aria-hidden="true">*</span>'
            : '<span class="form-optional">(optional)</span>'}
        </label>
        <input id="f-phone" class="form-input ${S.errors.phone ? 'form-input--error' : ''}"
               type="tel" placeholder="+41 79 000 00 00" autocomplete="tel"
               value="${escHtml(S.phone)}" data-field="phone" />
        ${S.errors.phone ? `<p class="form-error" role="alert">${escHtml(S.errors.phone)}</p>` : ''}
      </div>

      <div class="step-footer">
        <button class="btn btn-ghost" data-back>← Back</button>
        <button class="btn btn-primary" data-next>Continue →</button>
      </div>
    </div>
  `;
}

/* ── Payment choice (Flow A, Step 3) ────────────────────── */

function buildPaymentChoice() {
  const mkOption = (id, icon, title, desc) => {
    const sel = S.paymentMethod === id;
    return `
      <button class="payment-opt ${sel ? 'payment-opt--selected' : ''}"
              data-payment="${id}" aria-pressed="${sel}">
        <span class="payment-opt__icon" aria-hidden="true">${icon}</span>
        <div class="payment-opt__text">
          <strong>${title}</strong>
          <p>${desc}</p>
        </div>
        <span class="payment-opt__check" aria-hidden="true">✓</span>
      </button>
    `;
  };

  return `
    <div class="form-step">
      <p class="step-eyebrow">How would you like to pay?</p>
      ${S.errors.paymentMethod
        ? `<p class="form-error" role="alert">${escHtml(S.errors.paymentMethod)}</p>`
        : ''}

      <div class="payment-opts">
        ${mkOption(
          'pay-now', '⚡',
          'Pay Now',
          'Secure your slot immediately. You\'ll be redirected to Stripe to complete payment.'
        )}
        ${mkOption(
          'pay-later', '✉',
          'Pay Later',
          'Confirm by email first. Payment is due 24 hours before your session.'
        )}
      </div>

      <div class="step-footer">
        <button class="btn btn-ghost" data-back>← Back</button>
        <button class="btn btn-primary" data-next>Continue →</button>
      </div>
    </div>
  `;
}

/* ── Booking review (Flow A, Step 4) ────────────────────── */

function buildBookingReview() {
  const slot = S.selectedSlot;
  const rows = [
    ['Date & time', slot ? formatDateLong(slot.start) + ' · ' + formatTime(slot.start) : '—'],
    ['Name',        S.name],
    ['Email',       S.email],
    S.phone ? ['Phone', S.phone] : null,
    ['Payment',     S.paymentMethod === 'pay-now'
      ? 'Pay now via Stripe'
      : 'Pay later — invoice sent 24h before'],
  ].filter(Boolean);

  return `
    <div class="form-step">
      <p class="step-eyebrow">Review your booking</p>
      ${buildReviewTable(rows)}
      <div class="step-footer">
        <button class="btn btn-ghost" data-back>← Back</button>
        <button class="btn btn-primary" data-submit ${S.submitting ? 'disabled' : ''}>
          ${S.submitting ? 'Processing…' : 'Confirm Booking'}
        </button>
      </div>
    </div>
  `;
}

/* ── Event contact form (Flow B, Step 1) ─────────────────── */

function buildEventContactForm() {
  const isPaid = CTX.isPaid;

  const attendeesBlock = isPaid ? `
    <p class="form-section-title">
      Additional guests
      <span class="form-optional">(optional, up to 4)</span>
    </p>
    <div class="attendees-list">
      ${S.additionalAttendees.map((name, i) => `
        <div class="attendee-row">
          <input class="form-input" type="text"
                 placeholder="Guest ${i + 1} name"
                 value="${escHtml(name)}"
                 data-attendee="${i}"
                 aria-label="Guest ${i + 1} name" />
          <button class="attendee-remove-btn" data-remove-attendee="${i}"
                  aria-label="Remove guest ${i + 1}">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" stroke="currentColor"
                    stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      `).join('')}
    </div>
    ${S.additionalAttendees.length < 4
      ? `<button class="btn-add-attendee" data-add-attendee>+ Add another guest</button>`
      : ''}
    ${S.additionalAttendees.length > 0 && isPaid && CTX.price
      ? `<p class="attendee-total">
          Total: ${1 + S.additionalAttendees.length} guests ·
          CHF ${((1 + S.additionalAttendees.length) * CTX.price / 100).toFixed(2)}
         </p>`
      : ''}
  ` : '';

  return `
    <div class="form-step">
      <p class="step-eyebrow">Your details</p>

      <div class="form-group">
        <label class="form-label" for="f-name">Name <span class="required-star" aria-hidden="true">*</span></label>
        <input id="f-name" class="form-input ${S.errors.name ? 'form-input--error' : ''}"
               type="text" placeholder="Your full name" autocomplete="name"
               value="${escHtml(S.name)}" data-field="name" />
        ${S.errors.name ? `<p class="form-error" role="alert">${escHtml(S.errors.name)}</p>` : ''}
      </div>

      <div class="form-group">
        <label class="form-label" for="f-email">Email <span class="required-star" aria-hidden="true">*</span></label>
        <input id="f-email" class="form-input ${S.errors.email ? 'form-input--error' : ''}"
               type="email" placeholder="your@email.com" autocomplete="email"
               value="${escHtml(S.email)}" data-field="email" />
        ${S.errors.email ? `<p class="form-error" role="alert">${escHtml(S.errors.email)}</p>` : ''}
      </div>

      <div class="form-group">
        <label class="form-label" for="f-phone">
          Phone
          ${!isPaid
            ? '<span class="required-star" aria-hidden="true">*</span>'
            : '<span class="form-optional">(optional)</span>'}
        </label>
        <input id="f-phone" class="form-input ${S.errors.phone ? 'form-input--error' : ''}"
               type="tel" placeholder="+41 79 000 00 00" autocomplete="tel"
               value="${escHtml(S.phone)}" data-field="phone" />
        ${S.errors.phone ? `<p class="form-error" role="alert">${escHtml(S.errors.phone)}</p>` : ''}
        ${!isPaid
          ? `<p class="form-hint">Required for free events — we may reach out if needed.</p>`
          : ''}
      </div>

      ${attendeesBlock}

      <div class="step-footer">
        <div></div>
        <button class="btn btn-primary" data-next>Continue →</button>
      </div>
    </div>
  `;
}

/* ── Event review (Flow B, Step 2) ──────────────────────── */

function buildEventReview() {
  const isPaid    = CTX.isPaid;
  const total     = 1 + S.additionalAttendees.length;
  const guests    = S.additionalAttendees.filter(Boolean);

  const rows = [
    ['Event',   CTX.eventTitle],
    CTX.eventDisplay ? ['Date', CTX.eventDisplay] : null,
    ['Name',    S.name],
    ['Email',   S.email],
    S.phone  ? ['Phone', S.phone]  : null,
    guests.length ? ['Guests', guests.join(', ')] : null,
    isPaid && CTX.price
      ? ['Total', `${total} guest${total > 1 ? 's' : ''} · CHF ${(total * CTX.price / 100).toFixed(2)}`]
      : null,
    ['Type', isPaid
      ? 'Paid — Stripe checkout'
      : 'Free — email confirmation required'],
  ].filter(Boolean);

  return `
    <div class="form-step">
      <p class="step-eyebrow">Review your registration</p>
      ${buildReviewTable(rows)}
      <div class="step-footer">
        <button class="btn btn-ghost" data-back>← Back</button>
        <button class="btn btn-primary" data-submit ${S.submitting ? 'disabled' : ''}>
          ${S.submitting ? 'Processing…' : isPaid ? 'Proceed to Payment' : 'Complete Registration'}
        </button>
      </div>
    </div>
  `;
}

/* ── Confirmation screen (both flows, final step) ────────── */

function buildConfirmation() {
  const isEvent = CTX.source === 'event';
  const isPaid  = isEvent ? CTX.isPaid : S.paymentMethod === 'pay-now';

  // Non-paid flows — simple success
  if (!isPaid) {
    const noun   = isEvent ? 'registration' : 'booking';
    const widget = _buildConfirmationWidget(isEvent);
    return `
      <div class="confirmation">
        <div class="confirmation__icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="30" stroke="var(--color-lake)" stroke-width="1.25"/>
            <polyline points="18,32 28,42 46,22" stroke="var(--color-lake-light)"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2 class="confirmation__title">${isEvent ? 'Registration received!' : 'Booking received!'}</h2>
        <p class="confirmation__message">
          A confirmation email is on its way to <strong>${escHtml(S.email)}</strong>.
          Please confirm your ${noun} within 15 minutes.
        </p>
        ${widget ? `<div class="confirmation__calendar">${widget}</div>` : ''}
        <a href="index.html" class="btn btn-ghost confirmation__back">← Back to homepage</a>
      </div>
    `;
  }

  // Paid — waiting for simulation to run (paymentResult === null)
  if (S.paymentResult === null) {
    return `
      <div class="confirmation">
        <div class="confirmation__spinner" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none" class="spinner-ring">
            <circle cx="32" cy="32" r="28" stroke="var(--color-lake-mist)" stroke-width="3"/>
            <path d="M32 4a28 28 0 0 1 28 28" stroke="var(--color-lake)" stroke-width="3"
                  stroke-linecap="round"/>
          </svg>
        </div>
        <h2 class="confirmation__title">Redirecting to payment…</h2>
        <p class="confirmation__message">
          Connecting you to Stripe to complete your payment securely.
        </p>
      </div>
    `;
  }

  // paymentResult is always null here — redirect happens in handleSubmit
  return '';
}

/* ── Add-to-calendar widget for confirmation screens ─────── */

function _buildConfirmationWidget(isEvent) {
  if (typeof buildAtcWidget !== 'function') return '';

  if (isEvent && CTX.eventStart && CTX.eventEnd) {
    return buildAtcWidget({
      title:       CTX.eventTitle + ' — ILLUMINATE Evening',
      start:       CTX.eventStart,
      end:         CTX.eventEnd,
      location:    CTX.eventLocation || 'Lugano, Switzerland',
      description: 'ILLUMINATE Evening with Yair Benharroch.',
    });
  }

  if (!isEvent && S.selectedSlot) {
    return buildAtcWidget({
      title:       'Clarity Session — ILLUMINATE by Yair Benharroch',
      start:       S.selectedSlot.start,
      end:         S.selectedSlot.end,
      location:    'Lugano, Switzerland',
      description: '1:1 Clarity Session with Yair Benharroch.',
    });
  }

  return '';
}

/* ── Review table helper ─────────────────────────────────── */

function buildReviewTable(rows) {
  const items = rows.map(([label, value]) => `
    <div class="review-row">
      <dt>${escHtml(label)}</dt>
      <dd>${escHtml(String(value))}</dd>
    </div>
  `).join('');
  return `<dl class="review-table">${items}</dl>`;
}

/* ══════════════════════════════════════════════════════════
   6. EVENT LISTENERS
   ══════════════════════════════════════════════════════════ */

function attachListeners() {
  const app = document.getElementById('booking-app');
  if (!app) return;

  // Field inputs
  app.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', e => {
      let value = e.target.value;

      // Phone: strip anything that isn't a digit, +, -, (, ), space, or #
      if (e.target.dataset.field === 'phone') {
        const clean = value.replace(/[^\d+\-(). #]/g, '');
        if (clean !== value) {
          const cursor = e.target.selectionStart;
          // New cursor = number of valid chars before the original cursor position
          const newCursor = value.slice(0, cursor).replace(/[^\d+\-(). #]/g, '').length;
          e.target.value = clean;
          e.target.setSelectionRange(newCursor, newCursor);
          value = clean;
        }
      }

      S[e.target.dataset.field] = value;
      delete S.errors[e.target.dataset.field];
    });
  });

  // Calendar — month navigation
  const calPrev = app.querySelector('[data-cal-prev]');
  const calNext = app.querySelector('[data-cal-next]');
  if (calPrev) calPrev.addEventListener('click', () => {
    if (S.calMonth === 0) { S.calMonth = 11; S.calYear--; }
    else S.calMonth--;
    render();
  });
  if (calNext) calNext.addEventListener('click', () => {
    if (S.calMonth === 11) { S.calMonth = 0; S.calYear++; }
    else S.calMonth++;
    render();
  });

  // Calendar — day click (drill into slots)
  app.querySelectorAll('[data-date]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [y, m, d] = btn.dataset.date.split('-').map(Number);
      S.calViewDate  = new Date(y, m - 1, d);
      S.selectedSlot = null;
      render();
    });
  });

  // Calendar — back to month view
  const backMonth = app.querySelector('[data-cal-back-month]');
  if (backMonth) backMonth.addEventListener('click', () => {
    S.calViewDate = null;
    render();
  });

  // Slot selection
  app.querySelectorAll('[data-slot]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.selectedSlot = JSON.parse(btn.dataset.slot);
      render();
    });
  });

  // Payment choice
  app.querySelectorAll('[data-payment]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.paymentMethod = btn.dataset.payment;
      delete S.errors.paymentMethod;
      render();
    });
  });

  // Add attendee
  const addAttendee = app.querySelector('[data-add-attendee]');
  if (addAttendee) addAttendee.addEventListener('click', () => {
    if (S.additionalAttendees.length < 4) {
      S.additionalAttendees.push('');
      render();
      setTimeout(() => {
        const inputs = document.querySelectorAll('[data-attendee]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      }, 50);
    }
  });

  // Attendee name inputs
  app.querySelectorAll('[data-attendee]').forEach(input => {
    input.addEventListener('input', e => {
      S.additionalAttendees[Number(e.target.dataset.attendee)] = e.target.value;
    });
  });

  // Remove attendee
  app.querySelectorAll('[data-remove-attendee]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.additionalAttendees.splice(Number(btn.dataset.removeAttendee), 1);
      render();
    });
  });

  // Navigation buttons
  const nextBtn   = app.querySelector('[data-next]');
  const backBtn   = app.querySelector('[data-back]');
  const submitBtn = app.querySelector('[data-submit]');
  if (nextBtn)   nextBtn.addEventListener('click',   handleNext);
  if (backBtn)   backBtn.addEventListener('click',   handleBack);
  if (submitBtn) submitBtn.addEventListener('click', handleSubmit);

  // No retry/back buttons needed — paid flows redirect away to Stripe

  // Add-to-calendar widgets rendered in this step
  if (typeof initAddToCalendar === 'function') initAddToCalendar(app);
}

/* ══════════════════════════════════════════════════════════
   7. NAVIGATION + VALIDATION
   ══════════════════════════════════════════════════════════ */

function handleNext() {
  const isEvent = CTX.source === 'event';
  let errs = {};

  if (isEvent && S.step === 1) {
    errs = validateFields({ name: true, email: true, phone: !CTX.isPaid });
  } else if (!isEvent) {
    if (S.step === 2) errs = validateFields({ name: true, email: true });
    if (S.step === 3) errs = validateFields({ paymentMethod: true });
    // Step 1 (calendar): "Continue" only appears once a slot is selected — no extra guard needed
  }

  if (Object.keys(errs).length) {
    S.errors = errs;
    render();
    return;
  }

  S.errors = {};
  S.step++;
  render();
  scrollToApp();
}

function handleBack() {
  S.errors = {};
  S.step--;

  // Going back to calendar (Flow A step 1): restore day view if slot was selected
  if (!CTX.source || CTX.source === 'generic') {
    if (S.step === 1 && S.selectedSlot) {
      const d = new Date(S.selectedSlot.start);
      S.calViewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  }

  render();
  scrollToApp();
}

function scrollToApp() {
  const app = document.getElementById('booking-app');
  if (app) app.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════════════════
   8. SUBMISSION
   ══════════════════════════════════════════════════════════ */

async function handleSubmit() {
  S.submitting = true;
  render();

  try {
    let checkoutUrl = null;
    if (CTX.source === 'event') {
      const result = await submitEventRegistration();
      checkoutUrl = result.checkout_url || null;
    } else {
      const result = await submitBooking();
      checkoutUrl = result.checkout_url || null;
    }

    S.submitting    = false;
    S.paymentResult = null;
    S.step++;
    render();
    scrollToApp();

    if (checkoutUrl) {
      // Show "Redirecting to payment…" briefly then navigate
      setTimeout(() => { window.location.href = checkoutUrl; }, 400);
    }
  } catch (err) {
    console.error('[Book] Submission error:', err);
    S.submitting = false;
    render();
  }
}

async function submitBooking() {
  const payload = {
    slot_start:              S.selectedSlot.start,
    slot_end:                S.selectedSlot.end,
    timezone:                'Europe/Zurich',
    client_name:             S.name.trim(),
    client_email:            S.email.trim(),
    client_phone:            S.phone.trim() || null,
    reminder_email_opt_in:   true,
    reminder_whatsapp_opt_in: false,
    turnstile_token:         'placeholder',
  };

  let result;
  if (S.paymentMethod === 'pay-now') {
    result = await bookingPayNow(payload);
  } else {
    result = await bookingPayLater(payload);
  }

  console.log('[Book] Booking result:', result);
  return result;
}

async function submitEventRegistration() {
  const payload = {
    primary_name:             S.name.trim(),
    primary_email:            S.email.trim(),
    primary_phone:            S.phone.trim() || null,
    attendees:                S.additionalAttendees.filter(Boolean),
    reminder_email_opt_in:    true,
    reminder_whatsapp_opt_in: false,
    turnstile_token:          'placeholder',
    _isPaid:                  CTX.isPaid,
  };

  const result = await eventRegister(CTX.eventSlug, payload);
  console.log('[Book] Event registration result:', result);
  return result;
}

/* ══════════════════════════════════════════════════════════
   9. INIT
   ══════════════════════════════════════════════════════════ */

async function init() {
  if (CTX.source !== 'event') {
    // Fetch 6 weeks of available slots for the calendar
    const from = toYMD(new Date());
    const future = new Date();
    future.setDate(future.getDate() + 42);
    const to = toYMD(future);

    try {
      const data = await getSlots(from, to);
      S.slots = data.slots;
      S.slotsByDate = {};
      data.slots.forEach(slot => {
        const day = slot.start.slice(0, 10);
        if (!S.slotsByDate[day]) S.slotsByDate[day] = [];
        S.slotsByDate[day].push(slot);
        S.availableDates.add(day);
      });
    } catch (err) {
      console.error('[Book] Failed to load slots:', err);
    }

    const now = new Date();
    S.calYear  = now.getFullYear();
    S.calMonth = now.getMonth();
  }

  render();
}

document.addEventListener('DOMContentLoaded', init);
