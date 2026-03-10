(async function () {
  'use strict';
  const API_BASE = window.getSiteApiBase ? window.getSiteApiBase() : (window.API_BASE || '');
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const card = document.querySelector('.result-card');
  if (!card || !sessionId) return;

  try {
    const res = await fetch(`${API_BASE}/api/bookings/payment-status?session_id=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (!res.ok) return;

    const isConfirmed = data.status === 'confirmed' || data.status === 'cash_ok';
    const actionHref = data.next_action_url || data.manage_url || 'index.html';
    const actionText = data.next_action_label || (data.manage_url ? 'Manage booking' : '← Back to homepage');
    card.innerHTML = `
      <div class="result-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="30" stroke="var(--color-lake,#4a8fa8)" stroke-width="1.5"/>
          <polyline points="18,32 28,42 46,22" stroke="var(--color-lake,#4a8fa8)"
                    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h1 class="result-title">${isConfirmed ? 'Payment confirmed!' : 'Payment received'}</h1>
      <p class="result-msg">
        ${isConfirmed
          ? 'Your booking is confirmed. If your email is delayed, you can still continue from here.'
          : 'Your payment is being finalized. You can continue from here even if the confirmation email is delayed.'}
      </p>
      <a href="${actionHref}" class="btn btn-primary">${actionText}</a>
    `;
  } catch (_err) {
    // Keep the static fallback copy if recovery lookup fails.
  }
})();
