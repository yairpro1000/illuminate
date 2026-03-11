/* ============================================================
   ILLUMINATE — Booking flow
   Flow A: 1:1 session booking (calendar → slot → details → payment → review → done)
   Flow B: Event registration  (details → review → done)

   Depends on: api.js (loaded first in book.html)
   ============================================================ */

'use strict';
const BOOK_OBS = window.siteObservability || null;

/* ══════════════════════════════════════════════════════════
   1. BOOKING CONTEXT — parsed from URL query params
   ══════════════════════════════════════════════════════════ */

function parseBookingContext() {
  const p = new URLSearchParams(window.location.search);
  const source = p.get('source') || '1_on_1';
  const mode = p.get('mode') === 'reschedule' ? 'reschedule' : 'new';

  if (source === 'evening') {
    return {
      source:       'evening',
      mode:         'new',
      eventSlug:    p.get('eventSlug')    || '',
      eventAccessToken: p.get('access')   || '',
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

  // 'type' controls which slot kind is shown: 'intro' | 'session'
  // Default safely to 'intro' for unknown/missing values.
  const rawType = (p.get('type') || '').toLowerCase();
  const slotType = rawType === 'session' ? 'session' : 'intro';
  return {
    source: '1_on_1',
    slotType,
    mode,
    manageToken: p.get('token') || '',
    bookingId: p.get('id') || '',
  };
}

const CTX = parseBookingContext();
const SLOT_WINDOW_MONTHS = 4;

function isIntroFlow() {
  return CTX.source !== 'evening' && CTX.mode !== 'reschedule' && CTX.slotType === 'intro';
}

function isSessionPayNowFlow() {
  return CTX.source !== 'evening' && CTX.mode !== 'reschedule' && CTX.slotType === 'session' && S.paymentMethod === 'pay-now';
}

// Analytics — log booking context on page load
console.log('[Book] Booking context:', CTX);
console.log(
  '[Book] Source:',
  CTX.source === 'evening'
    ? 'event — ' + CTX.eventTitle + ' (' + CTX.eventDate + ')'
    : 'generic (1:1 booking)'
);

/* ══════════════════════════════════════════════════════════
   2. STATE
   ══════════════════════════════════════════════════════════ */

const S = {
  // Shared
  step: 1,
  firstName: '',
  lastName:  '',
  email: '',
  phone: '',
  errors: {},
  submitting: false,
  publicConfig: null,

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
  submissionStatus: null,                // API status from latest submit

  // Payment simulation (paid flows only)
  paymentResult: null,                   // null | 'success' | 'failure'

  // Reschedule mode
  currentBooking: null,                  // { starts_at, ends_at, status, ... }
  rescheduleUpdated: null,               // { starts_at, ends_at }
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
  if (fields.name) {
    if (!S.firstName.trim()) errs.firstName = 'Please enter your first name.';
    if (!S.lastName.trim())  errs.lastName  = 'Please enter your last name.';
  }
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

function getNonPaidConfirmationWindowMinutes() {
  const minutes = Number(
    S.publicConfig &&
    S.publicConfig.booking_policy &&
    S.publicConfig.booking_policy.non_paid_confirmation_window_minutes,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes;
}

function formatMinutesLabel(minutes) {
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
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
  const isEvent    = CTX.source === 'evening';
  const isReschedule = CTX.mode === 'reschedule';
  const totalSteps = isEvent ? 3 : (isReschedule ? 4 : (isIntroFlow() ? 4 : 5));
  const isFinal =
    (isEvent && S.step === 3) ||
    (!isEvent && isReschedule && S.step === 4) ||
    (!isEvent && !isReschedule && S.step === 5);

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
        ${S.errors.global ? `<p class="form-error" role="alert">${escHtml(S.errors.global)}</p>` : ''}
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
  if (CTX.mode === 'reschedule') {
    switch (S.step) {
      case 1: return buildCalendar();
      case 2: return buildContactForm(false);
      case 3: return buildRescheduleReview();
      case 4: return buildConfirmation();
      default: return '';
    }
  }

  if (isIntroFlow()) {
    switch (S.step) {
      case 1: return buildCalendar();
      case 2: return buildContactForm(false);
      case 3: return buildBookingReview();
      case 4: return buildConfirmation();
      default: return '';
    }
  }

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
  const maxDate = new Date(now.getFullYear(), now.getMonth() + SLOT_WINDOW_MONTHS + 1, 1);
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
      ${buildCurrentBookingPanel()}
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
      ${buildCurrentBookingPanel()}
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

function buildCurrentBookingPanel() {
  if (CTX.mode !== 'reschedule' || !S.currentBooking) return '';
  const current = S.currentBooking;
  const nextStart = S.selectedSlot?.start || S.rescheduleUpdated?.starts_at || null;
  return `
    <div class="reschedule-current">
      <p class="reschedule-current__label">Current booking</p>
      <p class="reschedule-current__row">${formatDateLong(current.starts_at)} · ${formatTime(current.starts_at)}</p>
      <p class="reschedule-current__meta">
        Status: ${escHtml(String(current.status || '—').replace('_', ' '))}
      </p>
      ${nextStart ? `
        <p class="reschedule-current__next">
          New slot: ${formatDateLong(nextStart)} · ${formatTime(nextStart)}
        </p>
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
      ${buildCurrentBookingPanel()}
      ${slotLine}
      <p class="step-eyebrow">Your details</p>

      <div class="form-name-row">
        <div class="form-group">
          <label class="form-label" for="f-first-name">First name <span class="required-star" aria-hidden="true">*</span></label>
          <input id="f-first-name" class="form-input ${S.errors.firstName ? 'form-input--error' : ''}"
                 type="text" placeholder="First name" autocomplete="given-name"
                 value="${escHtml(S.firstName)}" data-field="firstName" />
          ${S.errors.firstName ? `<p class="form-error" role="alert">${escHtml(S.errors.firstName)}</p>` : ''}
        </div>
        <div class="form-group">
          <label class="form-label" for="f-last-name">Last name <span class="required-star" aria-hidden="true">*</span></label>
          <input id="f-last-name" class="form-input ${S.errors.lastName ? 'form-input--error' : ''}"
                 type="text" placeholder="Last name" autocomplete="family-name"
                 value="${escHtml(S.lastName)}" data-field="lastName" />
          ${S.errors.lastName ? `<p class="form-error" role="alert">${escHtml(S.errors.lastName)}</p>` : ''}
        </div>
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

function buildRescheduleReview() {
  const slot = S.selectedSlot;
  const rows = [
    ['Current slot', S.currentBooking ? `${formatDateLong(S.currentBooking.starts_at)} · ${formatTime(S.currentBooking.starts_at)}` : '—'],
    ['New slot', slot ? `${formatDateLong(slot.start)} · ${formatTime(slot.start)}` : '—'],
    ['Name', [S.firstName, S.lastName].filter(Boolean).join(' ')],
    ['Email', S.email],
    S.phone ? ['Phone', S.phone] : null,
  ].filter(Boolean);

  return `
    <div class="form-step">
      ${buildCurrentBookingPanel()}
      <p class="step-eyebrow">Review your reschedule</p>
      ${buildReviewTable(rows)}
      <div class="step-footer">
        <button class="btn btn-ghost" data-back>← Back</button>
        <button class="btn btn-primary" data-submit ${S.submitting ? 'disabled' : ''}>
          ${S.submitting ? 'Updating…' : 'Confirm New Time'}
        </button>
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
    ['Name',        [S.firstName, S.lastName].filter(Boolean).join(' ')],
    ['Email',       S.email],
    S.phone ? ['Phone', S.phone] : null,
    ['Payment', isIntroFlow()
      ? 'Free intro — email confirmation required'
      : (S.paymentMethod === 'pay-now'
        ? 'Pay now via Stripe'
        : 'Pay later — payment due 24h before')],
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

  return `
    <div class="form-step">
      <p class="step-eyebrow">Your details</p>

      <div class="form-name-row">
        <div class="form-group">
          <label class="form-label" for="f-first-name">First name <span class="required-star" aria-hidden="true">*</span></label>
          <input id="f-first-name" class="form-input ${S.errors.firstName ? 'form-input--error' : ''}"
                 type="text" placeholder="First name" autocomplete="given-name"
                 value="${escHtml(S.firstName)}" data-field="firstName" />
          ${S.errors.firstName ? `<p class="form-error" role="alert">${escHtml(S.errors.firstName)}</p>` : ''}
        </div>
        <div class="form-group">
          <label class="form-label" for="f-last-name">Last name <span class="required-star" aria-hidden="true">*</span></label>
          <input id="f-last-name" class="form-input ${S.errors.lastName ? 'form-input--error' : ''}"
                 type="text" placeholder="Last name" autocomplete="family-name"
                 value="${escHtml(S.lastName)}" data-field="lastName" />
          ${S.errors.lastName ? `<p class="form-error" role="alert">${escHtml(S.errors.lastName)}</p>` : ''}
        </div>
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

      <div class="step-footer">
        <div></div>
        <button class="btn btn-primary" data-next>Continue →</button>
      </div>
    </div>
  `;
}

/* ── Event review (Flow B, Step 2) ──────────────────────── */

function buildEventReview() {
  const isPaid = CTX.isPaid;

  const rows = [
    ['Event',   CTX.eventTitle],
    CTX.eventDisplay ? ['Date', CTX.eventDisplay] : null,
    ['Name',    [S.firstName, S.lastName].filter(Boolean).join(' ')],
    ['Email',   S.email],
    S.phone  ? ['Phone', S.phone]  : null,
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
  const isEvent = CTX.source === 'evening';
  const isReschedule = CTX.mode === 'reschedule';
  const isPaid  = isEvent ? CTX.isPaid : isSessionPayNowFlow();

  if (isReschedule) {
    const startsAt = S.rescheduleUpdated?.starts_at || S.selectedSlot?.start || S.currentBooking?.starts_at;
    return `
      <div class="confirmation">
        <div class="confirmation__icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="30" stroke="var(--color-lake)" stroke-width="1.25"/>
            <polyline points="18,32 28,42 46,22" stroke="var(--color-lake-light)"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2 class="confirmation__title">Booking rescheduled</h2>
        <p class="confirmation__message">
          Your new session time is <strong>${startsAt ? `${escHtml(formatDateLong(startsAt))} · ${escHtml(formatTime(startsAt))}` : 'saved'}</strong>.
        </p>
        <a href="index.html" class="btn btn-ghost confirmation__back">← Back to homepage</a>
      </div>
    `;
  }

  // Non-paid flows — simple success
  if (!isPaid) {
    const isConfirmedNow = S.submissionStatus === 'confirmed';
    const noun = isEvent ? 'registration' : 'booking';
    const confirmWindowMinutes = getNonPaidConfirmationWindowMinutes();
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
        <h2 class="confirmation__title">${
          isConfirmedNow
            ? (isEvent ? 'Registration confirmed!' : 'Booking confirmed!')
            : (isEvent ? 'Registration received!' : 'Booking received!')
        }</h2>
        <p class="confirmation__message">
          ${
            isConfirmedNow
              ? `Your ${noun} is confirmed. A confirmation email is on its way to <strong>${escHtml(S.email)}</strong>.`
              : `A confirmation email is on its way to <strong>${escHtml(S.email)}</strong>.
          ${
            confirmWindowMinutes
              ? `Please confirm your ${noun} within ${formatMinutesLabel(confirmWindowMinutes)}.`
              : `Please confirm your ${noun} using the link in that email.`
          }`
          }
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
  const isEvent = CTX.source === 'evening';
  const isReschedule = CTX.mode === 'reschedule';
  let errs = {};

  if (isEvent && S.step === 1) {
    errs = validateFields({ name: true, email: true, phone: !CTX.isPaid });
  } else if (!isEvent) {
    if (S.step === 2) errs = validateFields({ name: true, email: true });
    if (!isReschedule && !isIntroFlow() && S.step === 3) errs = validateFields({ paymentMethod: true });
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
  if (!CTX.source || CTX.source === '1_on_1') {
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
    const flowId = BOOK_OBS && BOOK_OBS.startFlow ? BOOK_OBS.startFlow(
      CTX.source === 'evening' ? 'registration_flow_started' : (CTX.mode === 'reschedule' ? 'reschedule_flow_started' : 'booking_flow_started')
    ) : null;
    if (BOOK_OBS) {
      BOOK_OBS.logMilestone('business_event', {
        correlationId: flowId || BOOK_OBS.getCorrelationId(),
        flow: CTX.source === 'evening' ? 'event_registration' : (CTX.mode === 'reschedule' ? 'booking_reschedule' : 'booking_checkout'),
        step: S.step,
        source: CTX.source,
      });
    }
    let checkoutUrl = null;
    let status = null;
    if (CTX.mode === 'reschedule') {
      const result = await submitReschedule();
      S.rescheduleUpdated = { starts_at: result.starts_at, ends_at: result.ends_at };
    } else if (CTX.source === 'evening') {
      const result = await submitEventRegistration();
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
    } else {
      const result = await submitBooking();
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
    }

    S.submitting    = false;
    S.paymentResult = null;
    S.submissionStatus = status;
    S.step++;
    render();
    scrollToApp();

    if (checkoutUrl) {
      if (BOOK_OBS) BOOK_OBS.logMilestone('provider_result_persisted', { flow: 'checkout_redirect', checkout_created: true });
      // Show "Redirecting to payment…" briefly then navigate
      setTimeout(() => { window.location.href = checkoutUrl; }, 400);
    }
  } catch (err) {
    console.error('[Book] Submission error:', err);
    if (BOOK_OBS) {
      BOOK_OBS.logError({
        eventType: 'handled_exception',
        message: 'Booking form submission failed',
        error: {
          errorName: err && err.name || 'Error',
          stackTrace: err && err.stack || null,
          extra: { source: CTX.source, mode: CTX.mode },
        },
      });
    }
    S.submitting = false;
    render();
  }
}

async function submitBooking() {
  const payload = {
    slot_start:              S.selectedSlot.start,
    slot_end:                S.selectedSlot.end,
    timezone:                'Europe/Zurich',
    type:                    CTX.slotType,
    client_name:             [S.firstName, S.lastName].filter(Boolean).join(' '),
    client_email:            S.email.trim(),
    client_phone:            S.phone.trim() || null,
    reminder_email_opt_in:   true,
    reminder_whatsapp_opt_in: false,
    turnstile_token:         'placeholder',
  };

  let result;
  if (isIntroFlow()) {
    if (BOOK_OBS) BOOK_OBS.logMilestone('confirmation_email_requested', { flow: 'site_booking_intro', slot_start: payload.slot_start });
    result = await bookingPayLater(payload);
  } else if (S.paymentMethod === 'pay-now') {
    if (BOOK_OBS) BOOK_OBS.logMilestone('checkout_started', { flow: 'site_booking_pay_now', slot_start: payload.slot_start });
    result = await bookingPayNow(payload);
  } else {
    if (BOOK_OBS) BOOK_OBS.logMilestone('confirmation_email_requested', { flow: 'site_booking_pay_later', slot_start: payload.slot_start });
    result = await bookingPayLater(payload);
  }

  console.log('[Book] Booking result:', result);
  if (BOOK_OBS) BOOK_OBS.logMilestone('booking_created', { booking_id: result.booking_id, payment_method: S.paymentMethod });
  return result;
}

async function submitReschedule() {
  if (!S.selectedSlot) throw new Error('Please choose a new slot.');
  if (!CTX.manageToken || !CTX.bookingId) throw new Error('Missing reschedule token.');

  const payload = {
    token:     CTX.manageToken,
    new_start: S.selectedSlot.start,
    new_end:   S.selectedSlot.end,
    timezone:  'Europe/Zurich',
  };

  if (BOOK_OBS) BOOK_OBS.logMilestone('checkout_started', { flow: 'site_reschedule', booking_id: CTX.bookingId });
  const result = await bookingReschedule(payload);
  console.log('[Book] Reschedule result:', result);
  if (BOOK_OBS) BOOK_OBS.logMilestone('booking_rescheduled', { booking_id: result.booking_id });
  return result;
}

async function submitEventRegistration() {
  const payload = {
    first_name:               S.firstName.trim(),
    last_name:                S.lastName.trim() || null,
    email:                    S.email.trim(),
    phone:                    S.phone.trim() || null,
    reminder_email_opt_in:    true,
    reminder_whatsapp_opt_in: false,
    turnstile_token:          'placeholder',
  };

  if (BOOK_OBS) BOOK_OBS.logMilestone('registration_started', { event_slug: CTX.eventSlug });
  const result = CTX.eventAccessToken
    ? await eventBookWithAccess(CTX.eventSlug, Object.assign({ access_token: CTX.eventAccessToken }, payload))
    : await eventBook(CTX.eventSlug, payload);
  console.log('[Book] Event registration result:', result);
  if (BOOK_OBS) BOOK_OBS.logMilestone('registration_created', { booking_id: result.booking_id, event_slug: CTX.eventSlug });
  return result;
}

async function loadRescheduleContext() {
  if (CTX.mode !== 'reschedule') return;
  if (!CTX.manageToken || !CTX.bookingId) throw new Error('Invalid reschedule link.');

  const params = new URLSearchParams({ token: CTX.manageToken });
  const data = await _get('/api/bookings/manage?' + params.toString());
  S.currentBooking = data;
  S.firstName = data.client?.first_name || '';
  S.lastName  = data.client?.last_name || '';
  S.email = data.client?.email || '';
  S.phone = data.client?.phone || '';

  if (data.starts_at && data.ends_at) {
    const existing = { start: data.starts_at, end: data.ends_at };
    S.selectedSlot = existing;
    const d = new Date(existing.start);
    S.calViewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
}

async function loadPublicConfig() {
  try {
    const data = await getPublicConfig();
    const minutes = Number(
      data &&
      data.booking_policy &&
      data.booking_policy.non_paid_confirmation_window_minutes,
    );
    const validConfig = Number.isFinite(minutes) && minutes > 0;
    S.publicConfig = validConfig ? data : null;

    if (!validConfig) {
      console.warn('[Book] Public config returned invalid booking policy:', data);
      if (BOOK_OBS) {
        BOOK_OBS.logError({
          eventType: 'public_config_invalid',
          message: 'Public booking policy config is invalid',
          context: {
            branch_taken: 'deny_invalid_public_booking_policy_payload',
            deny_reason: 'non_paid_confirmation_window_minutes_invalid',
          },
        });
      }
      return;
    }

    if (BOOK_OBS) {
      BOOK_OBS.logMilestone('public_config_loaded', {
        config_version: data.config_version || null,
        non_paid_confirmation_window_minutes: minutes,
      });
    }
  } catch (err) {
    console.warn('[Book] Failed to load public config:', err);
    S.publicConfig = null;
    if (BOOK_OBS) {
      BOOK_OBS.logError({
        eventType: 'public_config_load_failed',
        message: err && err.message ? err.message : 'Public config request failed',
      });
    }
  }
}

/* ══════════════════════════════════════════════════════════
   9. INIT
   ══════════════════════════════════════════════════════════ */

async function init() {
  if (BOOK_OBS) {
    BOOK_OBS.logMilestone('page_loaded', {
      page: 'book',
      source: CTX.source,
      mode: CTX.mode,
    });
  }
  await loadPublicConfig();
  try {
    await loadRescheduleContext();
  } catch (err) {
    console.error('[Book] Failed to load reschedule context:', err);
    S.errors = { global: 'This reschedule link is invalid or expired.' };
  }

  if (CTX.source !== 'evening') {
    // Fetch 4 months of available slots for the calendar
    const from = toYMD(new Date());
    const future = new Date();
    future.setMonth(future.getMonth() + SLOT_WINDOW_MONTHS);
    const to = toYMD(future);

    try {
      const data = await getSlots(from, to, CTX.slotType);
      S.slots = Array.isArray(data.slots) ? data.slots : [];
      S.slotsByDate = {};
      S.slots.forEach(slot => {
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
