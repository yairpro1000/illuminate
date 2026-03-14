/* ============================================================
   ILLUMINATE — Booking flow
   Flow A: 1:1 session booking (calendar → slot → details → payment → review → done)
   Flow B: Event registration  (details → review → done)

   Depends on: api.js (loaded first in book.html)
   ============================================================ */

(function initBookPage() {
'use strict';
const BOOK_OBS = window.siteObservability || null;
const BOOK_PAGE_CLIENT = window.siteClient || null;
const SITE_CONFIG = BOOK_PAGE_CLIENT && BOOK_PAGE_CLIENT.config ? BOOK_PAGE_CLIENT.config : {};
const BOOK_SHARED = window.BookPageShared || {};
const BOOK_EFFECTS = window.BookPageEffects || {};
const BOOK_VIEWS = window.BookPageViews || {};
const parseBookingContext = BOOK_SHARED.parseBookingContext;
const toYMD = BOOK_SHARED.toYMD;
const formatTime = BOOK_SHARED.formatTime;
const formatDateLong = BOOK_SHARED.formatDateLong;
const formatDateShort = BOOK_SHARED.formatDateShort;
const validateFields = BOOK_SHARED.validateFields;
const escHtml = BOOK_SHARED.escHtml;
const buildBookingPolicyBlock = BOOK_SHARED.buildBookingPolicyBlock;
const getNonPaidConfirmationWindowMinutes = BOOK_SHARED.getNonPaidConfirmationWindowMinutes;
const formatMinutesLabel = BOOK_SHARED.formatMinutesLabel;
const submitBooking = BOOK_EFFECTS.submitBooking;
const submitReschedule = BOOK_EFFECTS.submitReschedule;
const submitEventRegistration = BOOK_EFFECTS.submitEventRegistration;
const loadRescheduleContext = BOOK_EFFECTS.loadRescheduleContext;
const loadPublicConfig = BOOK_EFFECTS.loadPublicConfig;
const createBookPageViews = BOOK_VIEWS.createBookPageViews;

/* ══════════════════════════════════════════════════════════
   1. BOOKING CONTEXT — parsed from URL query params
   ══════════════════════════════════════════════════════════ */

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
  submissionError: null,                 // null | { kind, message, staleSlot }

  // Payment simulation (paid flows only)
  paymentResult: null,                   // null | 'success' | 'failure'

  // Reschedule mode
  currentBooking: null,                  // { starts_at, ends_at, status, ... }
  rescheduleUpdated: null,               // { starts_at, ends_at }
};

const VIEWS = createBookPageViews({
  ctx: CTX,
  state: S,
  siteConfig: SITE_CONFIG,
  helpers: {
    toYMD,
    formatTime,
    formatDateLong,
    formatDateShort,
    escHtml,
    buildBookingPolicyBlock,
    getNonPaidConfirmationWindowMinutes,
    formatMinutesLabel,
  },
  isIntroFlow,
  isSessionPayNowFlow,
  slotWindowMonths: SLOT_WINDOW_MONTHS,
});

/* ══════════════════════════════════════════════════════════
   3. HELPERS
   ══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   4. RENDER ENGINE
   ══════════════════════════════════════════════════════════ */

function render() {
  const app = document.getElementById('booking-app');
  if (!app) return;
  app.innerHTML = VIEWS.buildShell();
  attachListeners();
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
      S.submissionError = null;
      render();
    });
  });

  // Payment choice
  app.querySelectorAll('[data-payment]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.paymentMethod = btn.dataset.payment;
      delete S.errors.paymentMethod;
      S.submissionError = null;
      render();
    });
  });

  // Navigation buttons
  const nextBtn   = app.querySelector('[data-next]');
  const backBtn   = app.querySelector('[data-back]');
  const submitBtn = app.querySelector('[data-submit]');
  const repickSlotBtn = app.querySelector('[data-repick-slot]');
  if (nextBtn)   nextBtn.addEventListener('click',   handleNext);
  if (backBtn)   backBtn.addEventListener('click',   handleBack);
  if (submitBtn) submitBtn.addEventListener('click', handleSubmit);
  if (repickSlotBtn) repickSlotBtn.addEventListener('click', handleRepickSlot);

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
    errs = validateFields(S, { name: true, email: true, phone: !CTX.isPaid });
  } else if (!isEvent) {
    if (S.step === 2) errs = validateFields(S, { name: true, email: true });
    if (!isReschedule && !isIntroFlow() && S.step === 3) errs = validateFields(S, { paymentMethod: true });
    // Step 1 (calendar): "Continue" only appears once a slot is selected — no extra guard needed
  }

  if (Object.keys(errs).length) {
    S.errors = errs;
    render();
    return;
  }

  S.errors = {};
  S.submissionError = null;
  S.step++;
  render();
  scrollToApp();
}

function handleBack() {
  S.errors = {};
  S.submissionError = null;
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

function handleRepickSlot() {
  const staleSlot = S.submissionError && S.submissionError.staleSlot
    ? S.submissionError.staleSlot
    : S.selectedSlot;
  if (staleSlot && staleSlot.start) {
    const slotDate = new Date(staleSlot.start);
    S.calViewDate = new Date(slotDate.getFullYear(), slotDate.getMonth(), slotDate.getDate());
  } else {
    S.calViewDate = null;
  }
  S.selectedSlot = null;
  S.errors = {};
  S.submissionError = null;
  S.submitting = false;
  S.step = 1;
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
  S.submissionError = null;
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
      const result = await submitReschedule({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS });
      S.rescheduleUpdated = { starts_at: result.starts_at, ends_at: result.ends_at };
    } else if (CTX.source === 'evening') {
      const result = await submitEventRegistration({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS });
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
    } else {
      const result = await submitBooking({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS, isIntroFlow });
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
    }

    S.submitting    = false;
    S.paymentResult = null;
    S.submissionStatus = status;
    S.submissionError = null;
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
    const userMessage =
      (err && typeof err === 'object' && err.data && typeof err.data.message === 'string' && err.data.message)
      || (err && typeof err === 'object' && typeof err.message === 'string' && err.message)
      || 'Something went wrong. Please try again.';
    const isSlotUnavailable = /slot is no longer available/i.test(userMessage);
    S.errors = isSlotUnavailable ? {} : { global: userMessage };
    S.submissionError = isSlotUnavailable
      ? {
          kind: 'slot-unavailable',
          message: userMessage,
          staleSlot: S.selectedSlot ? { start: S.selectedSlot.start, end: S.selectedSlot.end } : null,
        }
      : null;
    S.submitting = false;
    render();
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
  await loadPublicConfig({ state: S, observability: BOOK_OBS });
  try {
    await loadRescheduleContext({ state: S, context: CTX });
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
})();
