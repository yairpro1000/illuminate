(async function () {
  'use strict';
  const API_BASE = window.getSiteApiBase ? window.getSiteApiBase() : (window.API_BASE || '');
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  const adminToken = params.get('admin_token');
  const card   = document.getElementById('manage-card');

  function renderLoadError(title, message) {
    card.innerHTML = `
      <h1 class="manage-title">${title}</h1>
      <p class="manage-subtitle">${message}</p>
      <a href="index.html" class="btn btn-ghost" style="margin-top:1rem">← Homepage</a>
    `;
  }

  function statusBadge(status) {
    const cls = ['SLOT_CONFIRMED','PAID','COMPLETED'].includes(status)
      ? 'confirmed'
      : ['PENDING_CONFIRMATION'].includes(status)
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

  async function parseResponseBody(res) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return await res.json();
    }

    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(text); } catch (_) {}
    }
    return { message: text.slice(0, 300) };
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

  if (!token) {
    renderLoadError('Invalid Manage Link', 'Please use the latest manage link from your email.');
    return;
  }

  let data;
  try {
    const query = new URLSearchParams({ token });
    if (adminToken) query.set('admin_token', adminToken);
    const res = await fetch(`${API_BASE}/api/bookings/manage?${query.toString()}`);
    data = await parseResponseBody(res);
    if (!res.ok) {
      const message = typeof data?.message === 'string' ? data.message : '';
      throw Object.assign(new Error(toFriendlyError(res.status, message)), { status: res.status });
    }
  } catch (err) {
    renderLoadError('Could Not Open Booking', err.message || 'Could not load booking details.');
    return;
  }

  const isBooking = data.source === 'session';
  const cancellable = Boolean(data.actions && data.actions.can_cancel);
  const reschedulable = Boolean(data.actions && data.actions.can_reschedule);
  const rescheduleParams = new URLSearchParams({
    type: data.session_type || 'intro',
    mode: 'reschedule',
    token,
    id: data.booking_id,
  });
  if (adminToken) rescheduleParams.set('admin_token', adminToken);
  const rescheduleHref = `book.html?${rescheduleParams.toString()}`;
  const policyText = data.policy?.text || '';
  const lockedMessage = data.policy?.locked_message || '';
  const showLockedMessage = Boolean(data.policy && data.policy.can_self_serve_change === false);

  const rows = isBooking ? [
    ['Status',   statusBadge(data.status)],
    ['Date',     formatDt(data.starts_at)],
    ['Address',  data.address_line || '—'],
    data.payment_due_at ? ['Payment due', formatDt(data.payment_due_at)] : null,
  ].filter(Boolean) : [
    ['Status',      statusBadge(data.status)],
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
    ${policyText ? `<div class="policy-box">${policyText}</div>` : ''}
    ${showLockedMessage ? `<div class="policy-box">${lockedMessage}</div>` : ''}
    <div class="manage-actions">
      ${reschedulable ? `<a href="${rescheduleHref}" class="btn btn-primary">Reschedule</a>` : ''}
      ${cancellable ? `<button class="btn btn-ghost" id="cancel-btn" style="border-color:oklch(70% 0.12 25);color:oklch(45% 0.15 25)">Cancel booking</button>` : ''}
      <a href="index.html" class="btn btn-ghost">← Homepage</a>
    </div>
  `;

  if (cancellable) {
    const dialogMsg = document.getElementById('cancel-dialog-msg');
    dialogMsg.textContent = data.is_paid
      ? 'This action cannot be undone online.\nA refund will be processed if the booking was paid.'
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
        const res = await fetch(`${API_BASE}/api/bookings/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(adminToken ? { token, admin_token: adminToken } : { token }),
        });
        const result = await parseResponseBody(res);
        if (!res.ok) {
          const resultMessage = typeof result?.message === 'string' ? result.message : '';
          throw new Error(toFriendlyError(res.status, resultMessage));
        }
        document.getElementById('cancel-dialog').setAttribute('hidden', '');
        card.innerHTML = `
          <h1 class="manage-title">Cancelled</h1>
          <p class="manage-subtitle">Your ${isBooking ? 'booking' : 'event booking'} has been cancelled.</p>
          <a href="index.html" class="btn btn-ghost" style="margin-top:1rem">← Homepage</a>
        `;
      } catch (err) {
        document.getElementById('cancel-yes').textContent = 'Yes, cancel booking';
        document.getElementById('cancel-yes').disabled = false;
        alert(err.message || 'Could not cancel booking.');
      }
    });
  }
})();
