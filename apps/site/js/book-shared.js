(function () {
  'use strict';

  const SITE_CLIENT = window.siteClient || null;
  const SITE_CONFIG = SITE_CLIENT && SITE_CLIENT.config ? SITE_CLIENT.config : {};
  const DEFAULT_BOOKING_POLICY_LINES = SITE_CONFIG.defaultBookingPolicyLines || [
    'Booking policy',
    'You can reschedule or cancel your booking up to 24 hours before the session.',
    'Within 24 hours of the session, bookings can no longer be changed online and are non-refundable.',
    'If an emergency occurs, please contact me directly.',
  ];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function parseBookingContext() {
    const p = new URLSearchParams(window.location.search);
    const source = p.get('source') || '1_on_1';
    const mode = p.get('mode') === 'reschedule' ? 'reschedule' : 'new';

    if (source === 'evening') {
      return {
        source: 'evening',
        mode: 'new',
        eventSlug: p.get('eventSlug') || '',
        eventAccessToken: p.get('access') || '',
        eventTitle: p.get('eventTitle') || 'ILLUMINATE Evening',
        eventDate: p.get('eventDate') || '',
        eventDisplay: p.get('eventDisplay') || '',
        isPaid: p.get('isPaid') === 'true',
        price: Number(p.get('price') || 0),
        eventStart: p.get('eventStart') || '',
        eventEnd: p.get('eventEnd') || '',
        eventLocation: p.get('eventLocation') || '',
      };
    }

    return {
      source: '1_on_1',
      slotType: (p.get('type') || '').toLowerCase() === 'session' ? 'session' : 'intro',
      offerSlug: p.get('offer') || '',
      mode,
      manageToken: p.get('token') || '',
      adminToken: p.get('admin_token') || '',
      bookingId: p.get('id') || '',
    };
  }

  function toYMD(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function formatTime(isoStr) {
    return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatDateLong(isoStr) {
    return new Date(isoStr.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function formatDateShort(isoStr) {
    return new Date(isoStr.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  }

  function validateFields(state, fields) {
    const errs = {};
    if (fields.name) {
      if (!state.firstName.trim()) errs.firstName = 'Please enter your first name.';
      if (!state.lastName.trim()) errs.lastName = 'Please enter your last name.';
    }
    if (fields.email) {
      if (!state.email.trim()) errs.email = 'Please enter your email.';
      else if (!EMAIL_RE.test(state.email)) errs.email = 'Please enter a valid email address.';
    }
    if (fields.phone) {
      if (!state.phone.trim()) errs.phone = 'Phone number is required for this registration.';
      else if (state.phone.replace(/\D/g, '').length < 7) errs.phone = 'Please enter a valid phone number.';
    }
    if (fields.paymentMethod && !state.paymentMethod) errs.paymentMethod = 'Please choose a payment option.';
    return errs;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getBookingPolicyLines(rawText) {
    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length >= 4 ? lines.slice(0, 4) : DEFAULT_BOOKING_POLICY_LINES;
  }

  function escapeWithContactLink(text, href) {
    return String(text || '')
      .split(/(contact)/gi)
      .map((part) => part.toLowerCase() === 'contact'
        ? `<a href="${escHtml(href)}">contact</a>`
        : escHtml(part))
      .join('');
  }

  function buildBookingPolicyBlock(rawText, contactHref) {
    const [title, firstRule, secondRule, thirdRule] = getBookingPolicyLines(rawText);
    const href = contactHref || SITE_CONFIG.contactHref || 'contact.html';
    return `
      <section class="booking-policy" aria-label="Booking policy">
        <p class="booking-policy__title"><strong><u>${escHtml(title)}</u></strong></p>
        <ul class="booking-policy__list">
          <li>${escHtml(firstRule)}</li>
          <li>${escHtml(secondRule)}</li>
          <li>${escapeWithContactLink(thirdRule, href)}</li>
        </ul>
      </section>
    `;
  }

  function getNonPaidConfirmationWindowMinutes(publicConfig) {
    const minutes = Number(
      publicConfig &&
      publicConfig.booking_policy &&
      publicConfig.booking_policy.non_paid_confirmation_window_minutes,
    );
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return minutes;
  }

  function formatMinutesLabel(minutes) {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }

  window.BookPageShared = {
    parseBookingContext,
    toYMD,
    formatTime,
    formatDateLong,
    formatDateShort,
    validateFields,
    escHtml,
    buildBookingPolicyBlock,
    getNonPaidConfirmationWindowMinutes,
    formatMinutesLabel,
  };
})();
