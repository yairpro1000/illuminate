(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const siteConfig = siteClient && siteClient.config ? siteClient.config : {};
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  const adminToken = params.get('admin_token');
  const card   = document.getElementById('manage-card');
  const contactHref = siteConfig.contactHref || 'contact.html';
  const homepageHref = siteClient && typeof siteClient.resolveHomepageHref === 'function'
    ? siteClient.resolveHomepageHref()
    : (function () {
        try { return new URL('/index.html', window.location.origin).toString(); } catch (_) { return 'index.html'; }
      }());

  function renderLoadError(title, message) {
    card.innerHTML = `
      <h1 class="manage-title">${title}</h1>
      <p class="manage-subtitle">${message}</p>
      <a href="${homepageHref}" class="btn btn-ghost" style="margin-top:1rem">← Homepage</a>
    `;
  }

  function statusBadge(status) {
    const cls = ['CONFIRMED', 'COMPLETED'].includes(status)
      ? 'confirmed'
      : ['PENDING'].includes(status)
        ? 'pending'
        : 'cancelled';
    return `<span class="status-badge status-badge--${cls}">${String(status || '').replaceAll('_', ' ')}</span>`;
  }

  function formatDt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      weekday:'short', day:'numeric', month:'long', year:'numeric',
      hour:'2-digit', minute:'2-digit',
    });
  }
  function toFriendlyError(status, message) {
    if (status === 400 || status === 404) {
      return 'This manage link is invalid or expired. Please use the latest link from your email.';
    }
    if (status >= 500) {
      return 'We could not open your booking right now. Please try again in a moment.';
    }
    return message || 'Could not load booking details.';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function withContactLink(value) {
    return escapeHtml(value).replace(/\bcontact\b/gi, (word) => `<a href="contact.html">${word}</a>`);
  }

  const DEFAULT_BOOKING_POLICY_LINES = siteConfig.defaultBookingPolicyLines || [
    'Booking policy',
    'You can reschedule or cancel your booking up to 24 hours before the session.',
    'Within 24 hours of the session, bookings can no longer be changed online and are non-refundable.',
    'If an emergency occurs, please contact me directly.',
  ];

  function getBookingPolicyLines(rawText) {
    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length >= 4 ? lines.slice(0, 4) : DEFAULT_BOOKING_POLICY_LINES;
  }

  function escapeWithContactLink(value) {
    return String(value || '')
      .split(/(contact)/gi)
      .map((part) => part.toLowerCase() === 'contact' ? '<a href="contact.html">contact</a>' : escapeHtml(part))
      .join('');
  }

  function bookingPolicyHtml(rawText) {
    const [title, firstRule, secondRule, thirdRule] = getBookingPolicyLines(rawText);
    return `
      <section class="policy-box policy-box--booking" aria-label="Booking policy">
        <p class="policy-box__title"><strong><u>${escapeHtml(title)}</u></strong></p>
        <ul class="policy-box__list">
          <li>${escapeHtml(firstRule)}</li>
          <li>${escapeHtml(secondRule)}</li>
          <li>${escapeWithContactLink(thirdRule)}</li>
        </ul>
      </section>
    `;
  }

  function renderRefundLinks(refund) {
    if (!refund || refund.status !== 'SUCCEEDED') return '';
    const links = [
      refund.creditNoteUrl ? `<a href="${escapeHtml(refund.creditNoteUrl)}" class="btn btn-ghost">View credit note</a>` : '',
      refund.receiptUrl ? `<a href="${escapeHtml(refund.receiptUrl)}" class="btn btn-ghost">View receipt</a>` : '',
      refund.invoiceUrl ? `<a href="${escapeHtml(refund.invoiceUrl)}" class="btn btn-ghost">View invoice</a>` : '',
    ].filter(Boolean).join('');
    if (!links) return '';
    return `<div class="manage-actions" style="margin-top:1rem">${links}</div>`;
  }

  function renderCalendarSection(calendarEvent) {
    if (!calendarEvent || typeof buildAtcWidget !== 'function') return '';
    return `
      <div class="confirmation__calendar">
        <p class="manage-subtitle" style="margin:0 0 1rem">Add this booking to your calendar.</p>
        ${buildAtcWidget(calendarEvent)}
      </div>
    `;
  }

  function resolveRescheduleSlotType(payload) {
    const explicitType = String(payload?.session_type || payload?.slot_type || '').toLowerCase();
    if (explicitType === 'intro' || explicitType === 'session') {
      return { slotType: explicitType, reason: 'explicit_type' };
    }

    const startMs = Date.parse(payload?.starts_at || '');
    const endMs = Date.parse(payload?.ends_at || '');
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const durationMinutes = Math.round((endMs - startMs) / 60000);
      return {
        slotType: durationMinutes <= 45 ? 'intro' : 'session',
        reason: 'duration_heuristic',
      };
    }

    const title = String(payload?.title || '').toLowerCase();
    if (title.includes('intro')) {
      return { slotType: 'intro', reason: 'title_heuristic' };
    }

    return { slotType: 'session', reason: 'fallback_default_session' };
  }

  if (!token) {
    renderLoadError('Invalid Manage Link', 'Please use the latest manage link from your email.');
    return;
  }

  let data;
  try {
    const query = new URLSearchParams({ token });
    if (adminToken) query.set('admin_token', adminToken);
    data = await siteClient.requestJson(`/api/bookings/manage?${query.toString()}`);
  } catch (err) {
    renderLoadError('Could Not Open Booking', toFriendlyError(err.status, err.message || 'Could not load booking details.'));
    return;
  }

  const isBooking = data.source === 'session';
  const cancellable = Boolean(data.actions && data.actions.can_cancel);
  const reschedulable = Boolean(data.actions && data.actions.can_reschedule);
  const completablePayment = Boolean(data.actions && data.actions.can_complete_payment && data.actions.continue_payment_url);
  const rescheduleType = resolveRescheduleSlotType(data);
  console.info('[Manage] Reschedule slot type resolved', {
    booking_id: data.booking_id || null,
    source: data.source || null,
    slot_type: rescheduleType.slotType,
    reason: rescheduleType.reason,
  });
  const rescheduleParams = new URLSearchParams({
    type: rescheduleType.slotType,
    mode: 'reschedule',
    token,
    id: data.booking_id,
  });
  if (adminToken) rescheduleParams.set('admin_token', adminToken);
  const rescheduleHref = `book.html?${rescheduleParams.toString()}`;
  const policyText = data.policy?.text || '';
  const lockedMessage = data.policy?.locked_message || '';
  const showLockedMessage = Boolean(data.policy && data.policy.can_self_serve_change === false);
  const calendarHtml = renderCalendarSection(data.calendar_event);

  const rows = isBooking ? [
    ['Status',   statusBadge(data.status)],
    data.payment_status ? ['Payment', statusBadge(data.payment_status)] : null,
    ['Date',     formatDt(data.starts_at)],
    ['Address',  data.address_line || '—'],
    data.payment_due_at ? ['Payment due', formatDt(data.payment_due_at)] : null,
  ].filter(Boolean) : [
    ['Status',      statusBadge(data.status)],
    data.payment_method_label ? ['Payment method', escapeHtml(data.payment_method_label)] : null,
    data.payment_status ? ['Payment', statusBadge(data.payment_status)] : null,
    ['Event',       data.title || data.event?.title || '—'],
    ['Date',        formatDt(data.starts_at)],
  ].filter(Boolean);

  card.innerHTML = `
    <h1 class="manage-title">${isBooking ? 'Your Booking' : 'Your Event Booking'}</h1>
    <p class="manage-subtitle">${[data.client?.first_name || '', data.client?.last_name || ''].filter(Boolean).join(' ')}</p>
    <table class="detail-table" aria-label="Booking details">
      <tbody>
        ${rows.map(([label, val]) => `<tr><th>${label}</th><td>${val}</td></tr>`).join('')}
      </tbody>
    </table>
    ${data.payment_method_message ? `<div class="policy-box policy-box--text">${escapeHtml(data.payment_method_message)}</div>` : ''}
    ${policyText ? bookingPolicyHtml(policyText) : ''}
    ${showLockedMessage ? `<div class="policy-box policy-box--text">${withContactLink(lockedMessage)}</div>` : ''}
    ${renderRefundLinks(data.refund || null)}
    ${calendarHtml}
    <div class="manage-actions">
      ${reschedulable ? `<a href="${rescheduleHref}" class="btn btn-primary">Reschedule</a>` : ''}
      ${completablePayment ? `<a href="${escapeHtml(data.actions.continue_payment_url)}" class="btn btn-primary">Complete payment</a>` : ''}
      ${cancellable ? `<button class="btn btn-ghost" id="cancel-btn" style="border-color:oklch(70% 0.12 25);color:oklch(45% 0.15 25)">Cancel booking</button>` : ''}
      <a href="${contactHref}" class="btn btn-ghost">Contact Yair</a>
      <a href="${homepageHref}" class="btn btn-ghost">← Homepage</a>
    </div>
  `;
  if (typeof initAddToCalendar === 'function') initAddToCalendar(card);

  if (cancellable) {
    const dialogMsg = document.getElementById('cancel-dialog-msg');
    dialogMsg.textContent = data.is_paid
      ? 'This action cannot be undone online.\nIf a refund applies, you\'ll receive a separate confirmation email.'
      : 'This action cannot be undone online.';
    document.getElementById('cancel-btn').addEventListener('click', () => {
      document.getElementById('cancel-dialog').removeAttribute('hidden');
    });
    document.getElementById('cancel-no').addEventListener('click', () => {
      document.getElementById('cancel-dialog').setAttribute('hidden', '');
    });
    document.getElementById('cancel-yes').addEventListener('click', async () => {
      document.getElementById('cancel-yes').textContent = 'Cancelling…';
      document.getElementById('cancel-yes').disabled = true;
      try {
        const cancelResult = await siteClient.requestJson('/api/bookings/cancel', {
          method: 'POST',
          body: JSON.stringify(adminToken ? { token, admin_token: adminToken } : { token }),
        });
        const cancelSnapshot = cancelResult.booking_event && typeof window.pollBookingEventStatus === 'function'
          ? await window.pollBookingEventStatus(cancelResult.booking_event, token, adminToken, {
            intervalMs: 500,
            timeoutMs: 12_000,
          })
          : cancelResult;
        document.getElementById('cancel-dialog').setAttribute('hidden', '');
        card.innerHTML = `
          <h1 class="manage-title">Cancelled</h1>
          <p class="manage-subtitle">${escapeHtml(cancelSnapshot.message || cancelResult.message || `Your ${isBooking ? 'booking' : 'event booking'} has been cancelled.`)}</p>
          ${renderRefundLinks(cancelSnapshot.refund || cancelResult.refund || null)}
          <a href="${homepageHref}" class="btn btn-ghost" style="margin-top:1rem">← Homepage</a>
        `;
      } catch (err) {
        document.getElementById('cancel-yes').textContent = 'Yes, cancel booking';
        document.getElementById('cancel-yes').disabled = false;
        alert(toFriendlyError(err.status, err.message || 'Could not cancel booking.'));
      }
    });
  }
})();
