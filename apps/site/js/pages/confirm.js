(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const params  = new URLSearchParams(window.location.search);
  const token   = params.get('token');
  const card    = document.getElementById('confirm-card');

  function renderCalendarSection(calendarEvent, syncPendingRetry) {
    if (!calendarEvent || typeof buildAtcWidget !== 'function') return '';
    return `
      <div class="confirmation__calendar">
        <p class="confirm-msg" style="margin:0 0 1rem">
          ${syncPendingRetry
            ? 'Google Calendar is still catching up right now. Add this booking manually below.'
            : 'Add this booking to your calendar now.'}
        </p>
        ${buildAtcWidget(calendarEvent)}
      </div>
    `;
  }

  function show(icon, title, msg, linkHref, linkText, secondaryHref, secondaryText, extraHtml) {
    card.innerHTML = `
      <div class="confirm-icon" aria-hidden="true">${icon}</div>
      <h1 class="confirm-title">${title}</h1>
      <p class="confirm-msg">${msg}</p>
      ${extraHtml || ''}
      ${linkHref ? `<a href="${linkHref}" class="btn btn-primary">${linkText}</a>` : ''}
      ${secondaryHref ? `<a href="${secondaryHref}" class="btn btn-ghost" style="margin-top:1rem">${secondaryText}</a>` : ''}
    `;
    if (typeof initAddToCalendar === 'function') initAddToCalendar(card);
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
    const data = await siteClient.requestJson(`/api/bookings/confirm?token=${encodeURIComponent(token)}`);
    const isEvent = data.source === 'event';
    const awaitsPayment = String(data.next_action_label || '').toLowerCase() === 'complete payment';
    const calendarHtml = renderCalendarSection(data.calendar_event, data.calendar_sync_pending_retry);
    show(
      checkSvg,
      'Confirmed!',
      isEvent
        ? 'Your event booking is confirmed.'
        : (awaitsPayment
          ? 'Your booking is confirmed and awaiting payment.'
          : data.calendar_sync_pending_retry
            ? 'Your booking is confirmed. Google Calendar is delayed right now, but you can add it manually below.'
            : 'Your booking is confirmed.'),
      data.next_action_url || 'index.html',
      data.next_action_label || '← Back to homepage',
      'index.html',
      '← Back to homepage',
      calendarHtml,
    );
  } catch (err) {
    const expired = err && err.status === 410;
    if (expired || (err && err.status)) {
      show(
        warnSvg,
        expired ? 'Link expired' : 'Could not confirm',
        expired
          ? 'This confirmation link has expired. Please make a new booking.'
          : (err.message || 'Something went wrong. Please try again or contact us.'),
        'index.html',
        '← Homepage',
      );
      return;
    }
    show(warnSvg, 'Connection error', 'Could not reach the server. Please check your connection and try again.', 'index.html', '← Homepage');
  }
})();
