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
const SITE_COUPON = window.SiteCoupon || null;
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
const validateCouponCode = typeof validateCoupon === 'function' ? validateCoupon : null;
const loadSessionTypes = typeof getSessionTypes === 'function' ? getSessionTypes : null;

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

function isZeroPriceFlow() {
  const finalChf = S.pricePreview ? Number(S.pricePreview.finalChf) : NaN;
  return Boolean(
    S.pricePreview
    && Number(S.pricePreview.baseChf || 0) > 0
    && Number.isFinite(finalChf)
    && finalChf === 0
  );
}

function getBasePriceChf() {
  if (CTX.source === 'evening') return Number(CTX.price || 0);
  if (CTX.slotType === 'intro') return 0;
  return S.selectedSessionType ? Number(S.selectedSessionType.price || 0) : 0;
}

function refreshCouponPreview() {
  const basePrice = getBasePriceChf();
  if (SITE_COUPON && typeof SITE_COUPON.getDisplayedPrice === 'function') {
    S.pricePreview = SITE_COUPON.getDisplayedPrice(basePrice, S.appliedCouponCode || null);
  } else if (SITE_COUPON && typeof SITE_COUPON.getPricePreview === 'function') {
    S.pricePreview = SITE_COUPON.getPricePreview(basePrice, S.appliedCouponCode || null);
  } else {
    S.pricePreview = null;
  }
}

function syncCouponFromStorage(shouldRender) {
  const nextCode = SITE_COUPON && typeof SITE_COUPON.getAppliedCouponCode === 'function'
    ? SITE_COUPON.getAppliedCouponCode()
    : '';
  S.appliedCouponCode = nextCode || '';
  if (!S.couponCodeInput) {
    S.couponCodeInput = S.appliedCouponCode;
  } else if (shouldRender) {
    S.couponCodeInput = S.appliedCouponCode;
  }
  S.couponError = null;
  refreshCouponPreview();
  if (shouldRender) render();
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
  submissionManageUrl: null,
  submissionContinuePaymentUrl: null,
  submissionError: null,                 // null | { kind, message, staleSlot }

  // Payment simulation (paid flows only)
  paymentResult: null,                   // null | 'success' | 'failure'
  selectedSessionType: null,
  couponCodeInput: '',
  appliedCouponCode: '',
  couponError: null,
  couponValidating: false,
  pricePreview: null,

  // Reschedule mode
  currentBooking: null,                  // { starts_at, ends_at, status, ... }
  rescheduleUpdated: null,               // { starts_at, ends_at }

  // Turnstile
  turnstileTokenReady: false,
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
  isZeroPriceFlow,
  isAdminMode,
  slotWindowMonths: SLOT_WINDOW_MONTHS,
});

/* ══════════════════════════════════════════════════════════
   3. HELPERS
   ══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   4. RENDER ENGINE
   ══════════════════════════════════════════════════════════ */

function updateBookingSubmitBtnState() {
  if (CTX.mode === 'reschedule') return;
  const app = document.getElementById('booking-app');
  const btn = app && app.querySelector('[data-submit]');
  if (!btn) return;
  btn.disabled = isBookingSubmitBlocked();
}

function isBookingSubmitBlocked() {
  return !!(S.submitting || (SITE_CONFIG.turnstileEnabled && !S.turnstileTokenReady));
}

function render() {
  const app = document.getElementById('booking-app');
  if (!app) return;
  app.innerHTML = VIEWS.buildShell();
  attachListeners();
  mountTurnstileWidget();
  updateBookingSubmitBtnState();
}

function isAdminMode() {
  return !!(CTX.adminToken);
}

async function refreshSlots() {
  if (CTX.source === 'evening') return;

  const from = toYMD(new Date());
  const future = new Date();
  future.setMonth(future.getMonth() + SLOT_WINDOW_MONTHS);
  const to = toYMD(future);
  const tz = SITE_CONFIG.timezone || 'Europe/Zurich';

  let data;
  if (isAdminMode() && typeof getAdminSlots === 'function') {
    data = await getAdminSlots(from, to, tz, CTX.adminToken, CTX.bookingId || '');
  } else {
    data = await getSlots(
      from,
      to,
      CTX.slotType,
      tz,
      CTX.offerSlug || '',
      S.selectedSessionType && S.selectedSessionType.id ? S.selectedSessionType.id : '',
    );
  }

  const nextSlots = Array.isArray(data.slots) ? data.slots : [];
  S.slots = nextSlots;
  S.slotsByDate = {};
  S.availableDates = new Set();
  nextSlots.forEach(slot => {
    const day = slot.start.slice(0, 10);
    if (!S.slotsByDate[day]) S.slotsByDate[day] = [];
    S.slotsByDate[day].push(slot);
    // In admin mode every day with any slot (including blocked) is selectable.
    // In normal mode only unblocked slots make a date available.
    if (isAdminMode() || !slot.blocked) {
      S.availableDates.add(day);
    }
  });
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

  app.querySelectorAll('[data-coupon-input]').forEach((input) => {
    input.addEventListener('input', (e) => {
      S.couponCodeInput = e.target.value.toUpperCase();
      S.couponError = null;
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
      const raw = JSON.parse(btn.dataset.slot);
      if (isAdminMode()) {
        // In admin mode the slot step is 15 min, but the booking duration must
        // match the session type (new booking) or the original booking (reschedule).
        const startMs = new Date(raw.start).getTime();
        let durationMs = 0;
        if (CTX.mode === 'reschedule' && S.currentBooking && S.currentBooking.starts_at && S.currentBooking.ends_at) {
          durationMs = new Date(S.currentBooking.ends_at).getTime() - new Date(S.currentBooking.starts_at).getTime();
        } else if (S.selectedSessionType && S.selectedSessionType.duration_minutes > 0) {
          durationMs = S.selectedSessionType.duration_minutes * 60000;
        }
        S.selectedSlot = durationMs > 0
          ? { start: raw.start, end: new Date(startMs + durationMs).toISOString(), blocked: raw.blocked }
          : raw;
      } else {
        S.selectedSlot = raw;
      }
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
  app.querySelectorAll('[data-coupon-review-apply]').forEach((btn) => {
    btn.addEventListener('click', handleCouponApply);
  });
  app.querySelectorAll('[data-coupon-review-remove]').forEach((btn) => {
    btn.addEventListener('click', handleCouponRemove);
  });

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
      errs = validateFields(S, { name: true, email: true, phone: true });
    } else if (!isEvent) {
      if (S.step === 2) errs = validateFields(S, { name: true, email: true });
      if (!isReschedule && !isIntroFlow() && !isZeroPriceFlow() && S.step === 3) errs = validateFields(S, { paymentMethod: true });
      // Step 1 (calendar): "Continue" only appears once a slot is selected — no extra guard needed
    }

  if (Object.keys(errs).length) {
    S.errors = errs;
    render();
    return;
  }

  S.errors = {};
  S.submissionError = null;
  if (!isEvent && !isReschedule && !isIntroFlow() && S.step === 2 && isZeroPriceFlow()) {
    S.step = 4;
  } else {
    S.step++;
  }
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

async function handleRepickSlot() {
  const staleSlot = S.submissionError && S.submissionError.staleSlot
    ? S.submissionError.staleSlot
    : S.selectedSlot;
  S.submitting = true;
  render();

  try {
    await refreshSlots();
  } catch (err) {
    console.error('[Book] Failed to refresh slots after conflict:', err);
  }

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

async function handleCouponApply() {
  const normalized = SITE_COUPON && typeof SITE_COUPON.normalizeCouponCode === 'function'
    ? SITE_COUPON.normalizeCouponCode(S.couponCodeInput)
    : String(S.couponCodeInput || '').trim().toUpperCase();
  if (!normalized) {
    S.couponError = 'Enter a coupon code.';
    render();
    return;
  }
  if (!validateCouponCode) {
    S.couponError = 'Coupon validation is unavailable right now.';
    render();
    return;
  }

  S.couponValidating = true;
  S.couponError = null;
  render();

  try {
    const couponResult = await validateCouponCode(normalized);
    const discountPercent = couponResult && couponResult.coupon && couponResult.coupon.discount_percent;
    if (SITE_COUPON && typeof SITE_COUPON.setAppliedCouponCode === 'function') {
      SITE_COUPON.setAppliedCouponCode(normalized, 'review_apply', discountPercent);
    } else {
      S.appliedCouponCode = normalized;
      refreshCouponPreview();
    }
    S.couponCodeInput = normalized;
  } catch (err) {
    S.couponError = (err && err.data && err.data.message) || (err && err.message) || 'Coupon code is invalid.';
  } finally {
    S.couponValidating = false;
    refreshCouponPreview();
    render();
  }
}

function handleCouponRemove() {
  if (SITE_COUPON && typeof SITE_COUPON.clearAppliedCouponCode === 'function') {
    const removeLabel = S.appliedCouponCode || 'coupon';
    const shouldRemove = window.confirm(`Remove ${removeLabel} coupon and return to standard pricing?`);
    if (!shouldRemove) return;
    SITE_COUPON.clearAppliedCouponCode('review_remove');
  } else {
    S.appliedCouponCode = '';
    S.couponCodeInput = '';
    refreshCouponPreview();
    render();
  }
}

function scrollToApp() {
  const app = document.getElementById('booking-app');
  if (app) app.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════════════════════════════════
   8. SUBMISSION
   ══════════════════════════════════════════════════════════ */

async function handleSubmit() {
  if (isBookingSubmitBlocked()) return;
  clearTurnstileSubmitError();
  S.submissionError = null;
  S.submissionManageUrl = null;
  S.submissionContinuePaymentUrl = null;

  try {
    const submitTurnstileToken = await resolveBookingTurnstileToken();
    S.submitting = true;
    render();
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
    let manageUrl = null;
    let continuePaymentUrl = null;
    if (CTX.mode === 'reschedule') {
      const result = await submitReschedule({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS });
      S.rescheduleUpdated = { starts_at: result.starts_at, ends_at: result.ends_at };
    } else if (CTX.source === 'evening') {
      const result = await submitEventRegistration({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS, turnstileToken: submitTurnstileToken });
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
    } else {
      const result = await submitBooking({ state: S, context: CTX, config: SITE_CONFIG, observability: BOOK_OBS, isIntroFlow, turnstileToken: submitTurnstileToken });
      checkoutUrl = result.checkout_url || null;
      status = result.status || null;
      manageUrl = result.manage_url || null;
      continuePaymentUrl = result.continue_payment_url || null;
    }

    S.submitting    = false;
    S.paymentResult = null;
    S.submissionStatus = status;
    S.submissionManageUrl = manageUrl;
    S.submissionContinuePaymentUrl = continuePaymentUrl;
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
    if (window.SiteTurnstile && typeof window.SiteTurnstile.resetVisibleWidget === 'function') {
      window.SiteTurnstile.resetVisibleWidget(CTX.source === 'evening' ? 'event_registration_submit' : 'booking_submit');
    }
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

function clearTurnstileSubmitError() {
  delete S.errors.turnstile;
  syncTurnstileErrorUI();
}

async function resolveBookingTurnstileToken() {
  if (CTX.mode === 'reschedule' || !window.SiteTurnstile || typeof window.SiteTurnstile.resolveToken !== 'function') {
    return null;
  }

  return await window.SiteTurnstile.resolveToken({
    key: CTX.source === 'evening' ? 'event_registration_submit' : 'booking_submit',
    config: SITE_CONFIG,
    observability: BOOK_OBS,
    formName: CTX.source === 'evening' ? 'event_registration' : 'booking',
    action: CTX.source === 'evening' ? 'event_registration_submit' : 'booking_submit',
  });
}

function getActiveTurnstileHost(widgetKey) {
  const app = document.getElementById('booking-app');
  if (!app || !widgetKey) return null;
  return app.querySelector('[data-turnstile-host="' + widgetKey + '"]');
}

function syncTurnstileErrorUI(widgetKey) {
  const host = widgetKey ? getActiveTurnstileHost(widgetKey) : document.querySelector('[data-turnstile-host]');
  const wrapper = host ? host.closest('.turnstile-inline') : null;
  if (!wrapper) return;

  let errorEl = wrapper.querySelector('[data-turnstile-error]');
  if (S.errors.turnstile) {
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'form-error';
      errorEl.setAttribute('role', 'alert');
      errorEl.setAttribute('data-turnstile-error', 'true');
      wrapper.appendChild(errorEl);
    }
    errorEl.textContent = S.errors.turnstile;
  } else if (errorEl) {
    errorEl.remove();
  }
}

function mountTurnstileWidget() {
  const app = document.getElementById('booking-app');
  const host = app && app.querySelector('[data-turnstile-host]');
  if (!host || !window.SiteTurnstile || typeof window.SiteTurnstile.renderVisibleWidget !== 'function') return;

  const widgetKey = host.getAttribute('data-turnstile-host');
  const action = widgetKey === 'event_registration_submit' ? 'event_registration_submit' : 'booking_submit';

  S.turnstileTokenReady = false;
  updateBookingSubmitBtnState();
  window.SiteTurnstile.renderVisibleWidget({
    key: widgetKey,
    container: host,
    config: SITE_CONFIG,
    observability: BOOK_OBS,
    formName: widgetKey === 'event_registration_submit' ? 'event_registration' : 'booking',
    action: action,
    onToken: function () {
      const activeHost = getActiveTurnstileHost(widgetKey);
      if (!activeHost) {
        if (BOOK_OBS) {
          BOOK_OBS.logMilestone('turnstile_widget_callback_ignored', {
            widget_key: widgetKey,
            callback: 'token',
            branch_taken: 'ignore_stale_turnstile_token_callback',
          });
        }
        return;
      }
      S.turnstileTokenReady = true;
      updateBookingSubmitBtnState();
      delete S.errors.turnstile;
      syncTurnstileErrorUI(widgetKey);
    },
    onError: function (error) {
      const activeHost = getActiveTurnstileHost(widgetKey);
      if (!activeHost) {
        if (BOOK_OBS) {
          BOOK_OBS.logMilestone('turnstile_widget_callback_ignored', {
            widget_key: widgetKey,
            callback: 'error',
            error_code: error && error.code ? error.code : null,
            branch_taken: 'ignore_stale_turnstile_error_callback',
          });
        }
        return;
      }
      S.turnstileTokenReady = false;
      updateBookingSubmitBtnState();
      S.errors.turnstile = error && error.message ? error.message : 'Anti-bot verification failed.';
      syncTurnstileErrorUI(widgetKey);
    },
  }).catch(function (error) {
    S.turnstileTokenReady = false;
    updateBookingSubmitBtnState();
    S.errors.turnstile = error && error.message ? error.message : 'Anti-bot verification failed.';
    syncTurnstileErrorUI(widgetKey);
  });
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
  await loadPublicConfig({ state: S, config: SITE_CONFIG, observability: BOOK_OBS });
  syncCouponFromStorage(false);
  try {
    await loadRescheduleContext({ state: S, context: CTX });
  } catch (err) {
    console.error('[Book] Failed to load reschedule context:', err);
    S.errors = { global: 'This reschedule link is invalid or expired.' };
  }

  if (CTX.source !== 'evening') {
    if (loadSessionTypes) {
      try {
        const data = await loadSessionTypes();
        const rows = Array.isArray(data.session_types) ? data.session_types : [];
        const introCandidate = rows.find((row) => String(row.slug || '').includes('intro') || Number(row.price || 0) === 0);
        const explicitOffer = CTX.offerSlug ? rows.find((row) => row.slug === CTX.offerSlug) : null;
        const paidCandidate = rows.find((row) => row.id !== (introCandidate && introCandidate.id)) || rows[0] || null;
        S.selectedSessionType = CTX.slotType === 'intro'
          ? (introCandidate || rows[0] || null)
          : (explicitOffer || paidCandidate);
      } catch (err) {
        console.error('[Book] Failed to load session types:', err);
      }
    }

    try {
      await refreshSlots();
    } catch (err) {
      console.error('[Book] Failed to load slots:', err);
    }

    const now = new Date();
    S.calYear  = now.getFullYear();
    S.calMonth = now.getMonth();
  }

  if (CTX.prefillFirstName) S.firstName = CTX.prefillFirstName;
  if (CTX.prefillLastName)  S.lastName  = CTX.prefillLastName;
  if (CTX.prefillEmail)     S.email     = CTX.prefillEmail;
  if (CTX.prefillPhone)     S.phone     = CTX.prefillPhone;

  refreshCouponPreview();
  render();
}

window.addEventListener('sitecouponchange', () => {
  syncCouponFromStorage(true);
});

document.addEventListener('DOMContentLoaded', init);
})();
