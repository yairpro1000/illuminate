(async function () {
  'use strict';
  const API_BASE = window.getSiteApiBase ? window.getSiteApiBase() : (window.API_BASE || '');
  const params  = new URLSearchParams(window.location.search);
  const token   = params.get('token');
  const card    = document.getElementById('confirm-card');

  function show(icon, title, msg, linkHref, linkText) {
    card.innerHTML = `
      <div class="confirm-icon" aria-hidden="true">${icon}</div>
      <h1 class="confirm-title">${title}</h1>
      <p class="confirm-msg">${msg}</p>
      ${linkHref ? `<a href="${linkHref}" class="btn btn-primary">${linkText}</a>` : ''}
    `;
  }

  const checkSvg = `<svg viewBox="0 0 64 64" fill="none">
    <circle cx="32" cy="32" r="30" stroke="var(--color-lake,#4a8fa8)" stroke-width="1.5"/>
    <polyline points="18,32 28,42 46,22" stroke="var(--color-lake,#4a8fa8)"
              stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const warnSvg = `<svg viewBox="0 0 64 64" fill="none">
    <circle cx="32" cy="32" r="30" stroke="oklch(55% 0.18 25)" stroke-width="1.5"/>
    <line x1="32" y1="20" x2="32" y2="38" stroke="oklch(55% 0.18 25)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="32" cy="46" r="2.5" fill="oklch(55% 0.18 25)"/>
  </svg>`;

  if (!token) {
    show(warnSvg, 'Invalid link', 'This confirmation link is missing required information.', 'index.html', '← Homepage');
    return;
  }

  try {
    const url = `${API_BASE}/api/bookings/confirm?token=${encodeURIComponent(token)}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      const expired = res.status === 410;
      show(
        warnSvg,
        expired ? 'Link expired' : 'Could not confirm',
        expired
          ? 'This confirmation link has expired. Please make a new booking.'
          : (data.message || 'Something went wrong. Please try again or contact us.'),
        'index.html',
        '← Homepage',
      );
      return;
    }

    const isEvent = data.source === 'event';
    show(
      checkSvg,
      'Confirmed!',
      isEvent
        ? 'Your event booking is confirmed.'
        : (data.status === 'pending_payment'
          ? 'Your booking is confirmed and awaiting payment.'
          : 'Your booking is confirmed.'),
      data.next_action_url || 'index.html',
      data.next_action_label || '← Back to homepage',
    );
  } catch (err) {
    show(warnSvg, 'Connection error', 'Could not reach the server. Please check your connection and try again.', '', '');
  }
})();
