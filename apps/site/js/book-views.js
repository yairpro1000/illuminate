'use strict';

(function initBookPageViews(global) {
  function createBookPageViews(deps) {
    const {
      ctx,
      state,
      siteConfig,
      helpers,
      isIntroFlow,
      isSessionPayNowFlow,
      slotWindowMonths,
    } = deps;
    const {
      toYMD,
      formatTime,
      formatDateLong,
      formatDateShort,
      escHtml,
      buildBookingPolicyBlock,
      getNonPaidConfirmationWindowMinutes,
      formatMinutesLabel,
    } = helpers;

    function buildShell() {
      const isEvent = ctx.source === 'evening';
      const isReschedule = ctx.mode === 'reschedule';
      const totalSteps = isEvent ? 3 : (isReschedule ? 4 : (isIntroFlow() ? 4 : 5));
      const isFinal =
        (isEvent && state.step === 3) ||
        (!isEvent && isReschedule && state.step === 4) ||
        (!isEvent && !isReschedule && state.step === 5);

      return `
        <div class="booking-card">
          ${buildCouponSuggestion()}
          ${!isFinal ? `
            <header class="booking-header">
              <h1 class="booking-title">${isEvent ? 'Register' : 'Book a Session'}</h1>
              ${isEvent ? buildEventBanner() : ''}
              ${buildProgress(totalSteps)}
            </header>
          ` : ''}
          <div class="booking-body">
            ${state.errors.global ? `<p class="form-error" role="alert">${escHtml(state.errors.global)}</p>` : ''}
            ${isEvent ? buildEventFlow() : buildBookingFlow()}
          </div>
        </div>
      `;
    }

    function buildCouponSuggestion() {
      const siteCoupon = window.SiteCoupon || null;
      const basePrice = state.pricePreview && Number(state.pricePreview.baseChf || 0);
      if (!siteCoupon || typeof siteCoupon.buildSuggestionBannerHtml !== 'function' || !basePrice || basePrice <= 0 || state.appliedCouponCode) {
        return '';
      }
      return siteCoupon.buildSuggestionBannerHtml();
    }

    function buildEventBanner() {
      return `
        <div class="event-banner">
          <span class="event-banner__icon" aria-hidden="true">◈</span>
          <div>
            <p class="event-banner__title">${escHtml(ctx.eventTitle)}</p>
            ${ctx.eventDisplay
              ? `<p class="event-banner__date">${escHtml(ctx.eventDisplay)}</p>`
              : ''}
          </div>
        </div>
      `;
    }

    function buildProgress(total) {
      let html = '<nav class="booking-progress" aria-label="Booking steps">';
      for (let i = 1; i <= total; i++) {
        const done = i < state.step;
        const current = i === state.step;
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

    function buildBookingFlow() {
      if (ctx.mode === 'reschedule') {
        switch (state.step) {
          case 1: return buildCalendar();
          case 2: return buildContactForm(false);
          case 3: return buildRescheduleReview();
          case 4: return buildConfirmation();
          default: return '';
        }
      }

      if (isIntroFlow()) {
        switch (state.step) {
          case 1: return buildCalendar();
          case 2: return buildContactForm(false);
          case 3: return buildBookingReview();
          case 4: return buildConfirmation();
          default: return '';
        }
      }

      switch (state.step) {
        case 1: return buildCalendar();
        case 2: return buildContactForm(false);
        case 3: return buildPaymentChoice();
        case 4: return buildBookingReview();
        case 5: return buildConfirmation();
        default: return '';
      }
    }

    function buildEventFlow() {
      switch (state.step) {
        case 1: return buildEventContactForm();
        case 2: return buildEventReview();
        case 3: return buildConfirmation();
        default: return '';
      }
    }

    function buildCalendar() {
      if (state.calViewDate) return buildDaySlots();

      const year = state.calYear;
      const month = state.calMonth;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);
      const monthName = firstDay.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
      const startOffset = (firstDay.getDay() + 6) % 7;

      const now = new Date();
      const canPrev = year > now.getFullYear()
        || (year === now.getFullYear() && month > now.getMonth());
      const maxDate = new Date(now.getFullYear(), now.getMonth() + slotWindowMonths + 1, 1);
      const canNext = new Date(year, month + 1, 1) < maxDate;
      const days = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

      let cells = '';
      for (let i = 0; i < startOffset; i++) {
        cells += '<div class="cal-day cal-day--empty" aria-hidden="true"></div>';
      }

      for (let d = 1; d <= lastDay.getDate(); d++) {
        const date = new Date(year, month, d);
        date.setHours(0, 0, 0, 0);
        const ymd = toYMD(date);
        const isPast = date < today;
        const isAvailable = !isPast && state.availableDates.has(ymd);
        const isToday = ymd === toYMD(today);
        const cls = [
          'cal-day',
          isPast ? 'cal-day--past' : '',
          isToday ? 'cal-day--today' : '',
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
              <button class="cal-nav" data-cal-next aria-label="Next month" ${!canNext ? 'disabled' : ''}>›</button>
            </div>
            <div class="cal-grid" role="grid" aria-label="${monthName}">
              ${days.map((d) => `<div class="cal-weekday" role="columnheader" aria-label="${d}">${d}</div>`).join('')}
              ${cells}
            </div>
          </div>
          <p class="cal-legend"><span class="cal-legend__dot" aria-hidden="true"></span>Available dates</p>
        </div>
      `;
    }

    function buildDaySlots() {
      const date = state.calViewDate;
      const ymd = toYMD(date);
      const daySlots = state.slotsByDate[ymd] || [];
      const dateLabel = date.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
      });

      const slotBtns = daySlots.map((slot) => {
        const isSelected = state.selectedSlot && state.selectedSlot.start === slot.start;
        return `
          <button class="time-slot ${isSelected ? 'time-slot--selected' : ''}"
                  data-slot='${JSON.stringify(slot)}'
                  aria-pressed="${isSelected}">
            ${formatTime(slot.start)}
          </button>
        `;
      }).join('');

      const slotsContent = daySlots.length === 0
        ? `<p class="time-slots-empty">No other times are available on this day. Please choose another day.</p>`
        : `<div class="time-slots" role="group" aria-label="Available times">${slotBtns}</div>`;

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
          ${slotsContent}
          ${state.selectedSlot ? `
            <div class="step-footer">
              <div></div>
              <button class="btn btn-primary" data-next>Continue →</button>
            </div>
          ` : ''}
        </div>
      `;
    }

    function buildCurrentBookingPanel() {
      if (ctx.mode !== 'reschedule' || !state.currentBooking) return '';
      const current = state.currentBooking;
      const nextStart = state.selectedSlot?.start || state.rescheduleUpdated?.starts_at || null;
      return `
        <div class="reschedule-current">
          ${nextStart ? `
            <div class="reschedule-current__new">
              <p class="reschedule-current__new-label">NEW SLOT SELECTED</p>
              <p class="reschedule-current__new-time">${formatDateLong(nextStart)} · ${formatTime(nextStart)}</p>
            </div>
            <hr class="reschedule-current__divider" />
          ` : ''}
          <p class="reschedule-current__label">CURRENT BOOKING</p>
          <p class="reschedule-current__row reschedule-current__row--quiet">${formatDateLong(current.starts_at)} · ${formatTime(current.starts_at)}</p>
          <p class="reschedule-current__meta">
            Status: ${escHtml(String(current.status || '—').replace('_', ' '))}
          </p>
        </div>
      `;
    }

    function buildContactForm(requirePhone) {
      const slotLine = ctx.mode !== 'reschedule' && state.selectedSlot
        ? `<p class="selected-slot-chip">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style="vertical-align:-.15em">
              <rect x=".75" y="1.75" width="11.5" height="10.5" rx="1.75" stroke="currentColor" stroke-width="1.2"/>
              <path d="M.75 5.5h11.5M4.5.75v2M8.5.75v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            ${formatDateShort(state.selectedSlot.start)} · ${formatTime(state.selectedSlot.start)}
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
              <input id="f-first-name" class="form-input ${state.errors.firstName ? 'form-input--error' : ''}"
                     type="text" placeholder="First name" autocomplete="given-name"
                     value="${escHtml(state.firstName)}" data-field="firstName" />
              ${state.errors.firstName ? `<p class="form-error" role="alert">${escHtml(state.errors.firstName)}</p>` : ''}
            </div>
            <div class="form-group">
              <label class="form-label" for="f-last-name">Last name <span class="required-star" aria-hidden="true">*</span></label>
              <input id="f-last-name" class="form-input ${state.errors.lastName ? 'form-input--error' : ''}"
                     type="text" placeholder="Last name" autocomplete="family-name"
                     value="${escHtml(state.lastName)}" data-field="lastName" />
              ${state.errors.lastName ? `<p class="form-error" role="alert">${escHtml(state.errors.lastName)}</p>` : ''}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="f-email">Email <span class="required-star" aria-hidden="true">*</span></label>
            <input id="f-email" class="form-input ${state.errors.email ? 'form-input--error' : ''}"
                   type="email" placeholder="your@email.com" autocomplete="email"
                   value="${escHtml(state.email)}" data-field="email" />
            ${state.errors.email ? `<p class="form-error" role="alert">${escHtml(state.errors.email)}</p>` : ''}
          </div>

          <div class="form-group">
            <label class="form-label" for="f-phone">
              Phone
              ${requirePhone
                ? '<span class="required-star" aria-hidden="true">*</span>'
                : '<span class="form-optional">(optional)</span>'}
            </label>
            <input id="f-phone" class="form-input ${state.errors.phone ? 'form-input--error' : ''}"
                   type="tel" placeholder="+41 79 000 00 00" autocomplete="tel"
                   value="${escHtml(state.phone)}" data-field="phone" />
            ${state.errors.phone ? `<p class="form-error" role="alert">${escHtml(state.errors.phone)}</p>` : ''}
          </div>

          <div class="step-footer">
            <button class="btn btn-ghost" data-back>← Back</button>
            <button class="btn btn-primary" data-next>Continue →</button>
          </div>
        </div>
      `;
    }

    function buildRescheduleReview() {
      const slot = state.selectedSlot;
      const rows = [
        {
          label: 'Current slot',
          value: state.currentBooking ? `${formatDateLong(state.currentBooking.starts_at)} · ${formatTime(state.currentBooking.starts_at)}` : '—',
        },
        {
          label: 'New slot',
          value: slot ? `${formatDateLong(slot.start)} · ${formatTime(slot.start)}` : '—',
          rowClass: 'review-row--highlight',
        },
        { label: 'Name', value: [state.firstName, state.lastName].filter(Boolean).join(' ') },
        { label: 'Email', value: state.email },
        state.phone ? { label: 'Phone', value: state.phone } : null,
      ].filter(Boolean);

      return `
        <div class="form-step">
          <p class="step-eyebrow">Review your reschedule</p>
          ${buildReviewTable(rows)}
          <div class="step-footer">
            <button class="btn btn-ghost" data-back>← Back</button>
            <button class="btn btn-primary" data-submit ${state.submitting ? 'disabled' : ''}>
              ${state.submitting ? 'Updating…' : 'Confirm New Time'}
            </button>
          </div>
        </div>
      `;
    }

    function buildPaymentChoice() {
      const mkOption = (id, icon, title, desc) => {
        const selected = state.paymentMethod === id;
        return `
          <button class="payment-opt ${selected ? 'payment-opt--selected' : ''}"
                  data-payment="${id}" aria-pressed="${selected}">
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
          ${state.errors.paymentMethod
            ? `<p class="form-error" role="alert">${escHtml(state.errors.paymentMethod)}</p>`
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

    function buildBookingReview() {
      const slot = state.selectedSlot;
      const rows = [
        ['Date & time', slot ? formatDateLong(slot.start) + ' · ' + formatTime(slot.start) : '—'],
        state.selectedSessionType ? ['Offer', state.selectedSessionType.title] : null,
        ['Name', [state.firstName, state.lastName].filter(Boolean).join(' ')],
        ['Email', state.email],
        state.phone ? ['Phone', state.phone] : null,
        ['Payment', isIntroFlow()
          ? 'Free intro — email confirmation required'
          : (state.paymentMethod === 'pay-now'
            ? 'Pay now via Stripe'
            : 'Pay later — payment due 24h before')],
        state.pricePreview && Number(state.pricePreview.baseChf || 0) > 0
          ? { label: 'Price', value: buildCouponPriceSummary(), html: true }
          : null,
      ].filter(Boolean);
      const hasSlotConflict = state.submissionError && state.submissionError.kind === 'slot-unavailable';
      const staleSlot = hasSlotConflict
        ? (state.submissionError.staleSlot || state.selectedSlot)
        : null;
      const staleSlotLabel = staleSlot && staleSlot.start
        ? `${formatDateLong(staleSlot.start)} · ${formatTime(staleSlot.start)}`
        : 'Your previously selected time';

      return `
        <div class="form-step">
          ${hasSlotConflict ? buildSlotConflictState(staleSlotLabel) : '<p class="step-eyebrow">Review your booking</p>'}
          ${buildCouponEditor()}
          ${buildReviewTable(rows)}
          ${buildBookingPolicyBlock(state.publicConfig?.booking_policy_text)}
          ${hasSlotConflict
            ? ''
            : `<div class="step-footer">
                <button class="btn btn-ghost" data-back>← Back</button>
                <button class="btn btn-primary" data-submit ${state.submitting ? 'disabled' : ''}>
                  ${state.submitting ? 'Processing…' : 'Confirm Booking'}
                </button>
              </div>`}
        </div>
      `;
    }

    function buildSlotConflictState(staleSlotLabel) {
      const contactHref = siteConfig.contactHref || 'contact.html';
      return `
        <section class="booking-recovery booking-recovery--warning" role="alert" aria-live="assertive">
          <p class="booking-recovery__eyebrow">Time needs updating</p>
          <h2 class="booking-recovery__title">That time was just taken</h2>
          <p class="booking-recovery__message">
            No problem. Your details are saved, and you can choose another available slot now.
          </p>
          <div class="booking-recovery__stale-slot">
            <span class="booking-recovery__stale-label">Unavailable selection</span>
            <strong>${escHtml(staleSlotLabel)}</strong>
          </div>
          <div class="booking-recovery__actions">
            <button class="btn btn-primary" type="button" data-repick-slot>Choose another time</button>
            <a class="btn btn-secondary" href="${escHtml(contactHref)}">Contact Yair directly</a>
          </div>
        </section>
      `;
    }

    function buildEventContactForm() {
      const isPaid = ctx.isPaid;

      return `
        <div class="form-step">
          <p class="step-eyebrow">Your details</p>

          <div class="form-name-row">
            <div class="form-group">
              <label class="form-label" for="f-first-name">First name <span class="required-star" aria-hidden="true">*</span></label>
              <input id="f-first-name" class="form-input ${state.errors.firstName ? 'form-input--error' : ''}"
                     type="text" placeholder="First name" autocomplete="given-name"
                     value="${escHtml(state.firstName)}" data-field="firstName" />
              ${state.errors.firstName ? `<p class="form-error" role="alert">${escHtml(state.errors.firstName)}</p>` : ''}
            </div>
            <div class="form-group">
              <label class="form-label" for="f-last-name">Last name <span class="required-star" aria-hidden="true">*</span></label>
              <input id="f-last-name" class="form-input ${state.errors.lastName ? 'form-input--error' : ''}"
                     type="text" placeholder="Last name" autocomplete="family-name"
                     value="${escHtml(state.lastName)}" data-field="lastName" />
              ${state.errors.lastName ? `<p class="form-error" role="alert">${escHtml(state.errors.lastName)}</p>` : ''}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="f-email">Email <span class="required-star" aria-hidden="true">*</span></label>
            <input id="f-email" class="form-input ${state.errors.email ? 'form-input--error' : ''}"
                   type="email" placeholder="your@email.com" autocomplete="email"
                   value="${escHtml(state.email)}" data-field="email" />
            ${state.errors.email ? `<p class="form-error" role="alert">${escHtml(state.errors.email)}</p>` : ''}
          </div>

          <div class="form-group">
            <label class="form-label" for="f-phone">
              Phone
              ${!isPaid
                ? '<span class="required-star" aria-hidden="true">*</span>'
                : '<span class="form-optional">(optional)</span>'}
            </label>
            <input id="f-phone" class="form-input ${state.errors.phone ? 'form-input--error' : ''}"
                   type="tel" placeholder="+41 79 000 00 00" autocomplete="tel"
                   value="${escHtml(state.phone)}" data-field="phone" />
            ${state.errors.phone ? `<p class="form-error" role="alert">${escHtml(state.errors.phone)}</p>` : ''}
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

    function buildEventReview() {
      const isPaid = ctx.isPaid;
      const rows = [
        ['Event', ctx.eventTitle],
        ctx.eventDisplay ? ['Date', ctx.eventDisplay] : null,
        ['Name', [state.firstName, state.lastName].filter(Boolean).join(' ')],
        ['Email', state.email],
        state.phone ? ['Phone', state.phone] : null,
        ['Type', isPaid
          ? 'Paid — Stripe checkout'
          : 'Free — email confirmation required'],
        isPaid && state.pricePreview && Number(state.pricePreview.baseChf || 0) > 0
          ? { label: 'Price', value: buildCouponPriceSummary(), html: true }
          : null,
      ].filter(Boolean);

      return `
        <div class="form-step">
          <p class="step-eyebrow">Review your registration</p>
          ${isPaid ? buildCouponEditor() : ''}
          ${buildReviewTable(rows)}
          ${buildBookingPolicyBlock(state.publicConfig?.booking_policy_text)}
          <div class="step-footer">
            <button class="btn btn-ghost" data-back>← Back</button>
            <button class="btn btn-primary" data-submit ${state.submitting ? 'disabled' : ''}>
              ${state.submitting ? 'Processing…' : isPaid ? 'Proceed to Payment' : 'Complete Registration'}
            </button>
          </div>
        </div>
      `;
    }

    function buildConfirmation() {
      const isEvent = ctx.source === 'evening';
      const isReschedule = ctx.mode === 'reschedule';
      const isPaid = isEvent ? ctx.isPaid : isSessionPayNowFlow();

      if (isReschedule) {
        const startsAt = state.rescheduleUpdated?.starts_at || state.selectedSlot?.start || state.currentBooking?.starts_at;
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

      if (!isPaid) {
        const isConfirmedNow = state.submissionStatus === 'CONFIRMED';
        const noun = isEvent ? 'registration' : 'booking';
        const confirmWindowMinutes = getNonPaidConfirmationWindowMinutes(state.publicConfig);
        const widget = buildConfirmationWidget(isEvent);
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
                  ? `Your ${noun} is confirmed. A confirmation email is on its way to <strong>${escHtml(state.email)}</strong>.`
                  : `A confirmation email is on its way to <strong>${escHtml(state.email)}</strong>.
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

      if (state.paymentResult === null) {
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

      return '';
    }

    function buildConfirmationWidget(isEvent) {
      if (typeof buildAtcWidget !== 'function') return '';

      if (isEvent && ctx.eventStart && ctx.eventEnd) {
        return buildAtcWidget({
          title: ctx.eventTitle + ' — ILLUMINATE Evening',
          start: ctx.eventStart,
          end: ctx.eventEnd,
          location: ctx.eventLocation || siteConfig.defaultEventLocation || 'Lugano, Switzerland',
          description: 'ILLUMINATE Evening with Yair Benharroch.',
        });
      }

      if (!isEvent && state.selectedSlot) {
        return buildAtcWidget({
          title: 'Clarity Session — ILLUMINATE by Yair Benharroch',
          start: state.selectedSlot.start,
          end: state.selectedSlot.end,
          location: siteConfig.defaultSessionLocation || 'Lugano, Switzerland',
          description: '1:1 Clarity Session with Yair Benharroch.',
        });
      }

      return '';
    }

    function buildReviewTable(rows) {
      const items = rows.map((row) => {
        const rowObj = Array.isArray(row)
          ? { label: row[0], value: row[1], rowClass: '', html: false }
          : row;
        const extraClass = rowObj.rowClass ? ` ${rowObj.rowClass}` : '';
        return `
          <div class="review-row${extraClass}">
            <dt>${escHtml(rowObj.label)}</dt>
            <dd>${rowObj.html ? rowObj.value : escHtml(String(rowObj.value))}</dd>
          </div>
        `;
      }).join('');
      return `<dl class="review-table">${items}</dl>`;
    }

    function buildCouponEditor() {
      if (!state.pricePreview || Number(state.pricePreview.baseChf || 0) <= 0) return '';
      const applied = Boolean(state.appliedCouponCode);
      return `
        <section class="coupon-review">
          <div class="coupon-review__header">
            <p class="coupon-review__label">Coupon</p>
            ${applied ? `<span class="coupon-review__applied">Applied: ${escHtml(state.appliedCouponCode)}</span>` : ''}
          </div>
          <div class="coupon-review__row">
            <input
              class="form-input coupon-review__input ${state.couponError ? 'form-input--error' : ''}"
              type="text"
              placeholder="Enter coupon code"
              value="${escHtml(state.couponCodeInput || '')}"
              data-coupon-input
            />
            <button class="btn btn-secondary" type="button" data-coupon-review-apply ${state.couponValidating ? 'disabled' : ''}>
              ${state.couponValidating ? 'Applying…' : 'Apply'}
            </button>
            ${applied ? '<button class="btn btn-ghost" type="button" data-coupon-review-remove>Remove</button>' : ''}
          </div>
          ${state.couponError ? `<p class="form-error" role="alert">${escHtml(state.couponError)}</p>` : ''}
        </section>
      `;
    }

    function buildCouponPriceSummary() {
      const siteCoupon = window.SiteCoupon || null;
      if (!siteCoupon || typeof siteCoupon.buildPriceHtml !== 'function' || !state.pricePreview) {
        return '—';
      }
      return siteCoupon.buildPriceHtml(state.pricePreview.baseChf, 'CHF', {
        couponCode: state.appliedCouponCode || null,
      });
    }

    return {
      buildShell,
    };
  }

  global.BookPageViews = { createBookPageViews };
})(window);
