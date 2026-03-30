(async function () {
  'use strict';
  const siteClient = window.siteClient || null;
  const siteConfig = siteClient && siteClient.config ? siteClient.config : {};
  const params     = new URLSearchParams(window.location.search);
  const source     = params.get('source') || 'session';   // 'session' | 'event'
  const token      = params.get('token') || '';
  const adminToken = params.get('admin_token') || '';
  const prefillFirst = params.get('prefill_first') || '';
  const prefillLast  = params.get('prefill_last')  || '';
  const prefillEmail = params.get('prefill_email') || '';
  const prefillPhone = params.get('prefill_phone') || '';

  const card         = document.getElementById('rebook-card');
  const sessionsHref = siteConfig.sessionsHref || 'sessions.html';
  const eveningsHref = siteConfig.eveningsHref || 'evenings.html';
  const homepageHref = siteClient && typeof siteClient.resolveHomepageHref === 'function'
    ? siteClient.resolveHomepageHref()
    : (function () {
        try { return new URL('/index.html', window.location.origin).toString(); } catch (_) { return 'index.html'; }
      }());

  const manageBackHref = (function () {
    if (!token) return null;
    const p = new URLSearchParams({ token });
    if (adminToken) p.set('admin_token', adminToken);
    return `manage.html?${p.toString()}`;
  }());

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatEventDate(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // admin_token is forwarded so book.html uses admin slots for new bookings made
  // from the admin manage flow. manage token (token) is not forwarded — it is only
  // meaningful for reschedule mode and would not apply to a fresh booking.
  function buildForwardParams() {
    const p = new URLSearchParams();
    if (adminToken)   p.set('admin_token',   adminToken);
    if (prefillFirst) p.set('prefill_first', prefillFirst);
    if (prefillLast)  p.set('prefill_last',  prefillLast);
    if (prefillEmail) p.set('prefill_email', prefillEmail);
    if (prefillPhone) p.set('prefill_phone', prefillPhone);
    return p;
  }

  function renderActions() {
    const back = manageBackHref
      ? `<a href="${escapeHtml(manageBackHref)}" class="btn btn-ghost">← Back to booking</a>`
      : `<a href="${escapeHtml(homepageHref)}" class="btn btn-ghost">← Homepage</a>`;
    return `<div class="rebook-actions">${back}</div>`;
  }

  function renderError(message) {
    card.innerHTML = `
      <h1 class="rebook-title">Oops</h1>
      <p class="rebook-subtitle">${escapeHtml(message)}</p>
      ${renderActions()}
    `;
  }

  if (!siteClient) {
    renderError('Could not load page. Please try again.');
    return;
  }

  try {
    if (source === 'session') {
      const data     = await siteClient.requestJson('/api/session-types');
      const types    = Array.isArray(data.session_types) ? data.session_types : [];
      const prefill  = buildForwardParams();

      if (!types.length) {
        card.innerHTML = `
          <h1 class="rebook-title">Book a session</h1>
          <p class="rebook-subtitle">No sessions are currently available. Check back soon.</p>
          <a href="${escapeHtml(sessionsHref)}" class="rebook-browse">Browse sessions →</a>
          ${renderActions()}
        `;
        return;
      }

      const pills = types.map(st => {
        const isIntro = String(st.slug || '').includes('intro') || Number(st.price || 0) === 0;
        const p = new URLSearchParams({ type: isIntro ? 'intro' : 'session' });
        for (const [k, v] of prefill.entries()) p.set(k, v);
        const price    = Number(st.price || 0) === 0 ? 'Free' : `${st.currency || 'CHF'} ${st.price}`;
        const duration = st.duration_minutes ? `${st.duration_minutes} min` : '';
        const meta     = [duration, st.short_description].filter(Boolean).join(' · ');
        return `
          <a href="book.html?${escapeHtml(p.toString())}" class="rebook-pill">
            <span class="rebook-pill__content">
              <span class="rebook-pill__title">${escapeHtml(st.title)}</span>
              ${meta ? `<span class="rebook-pill__meta">${escapeHtml(meta)}</span>` : ''}
            </span>
            <span class="rebook-pill__price">${escapeHtml(price)}</span>
          </a>`;
      }).join('');

      card.innerHTML = `
        <h1 class="rebook-title">Book a session</h1>
        <p class="rebook-subtitle">Choose a session to book.</p>
        <div class="rebook-list">${pills}</div>
        <a href="${escapeHtml(sessionsHref)}" class="rebook-browse">Browse sessions page →</a>
        ${renderActions()}
      `;

    } else {
      const data   = await siteClient.requestJson('/api/events');
      const all    = Array.isArray(data.events) ? data.events : [];
      const events = all
        .filter(e => e.render && e.render.is_future && !e.render.sold_out)
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
      const prefill = buildPrefillParams();

      if (!events.length) {
        card.innerHTML = `
          <h1 class="rebook-title">Book an event</h1>
          <p class="rebook-subtitle">No upcoming events right now. Check back soon.</p>
          <a href="${escapeHtml(eveningsHref)}" class="rebook-browse">Browse evenings →</a>
          ${renderActions()}
        `;
        return;
      }

      const pills = events.map(ev => {
        const display  = formatEventDate(ev.starts_at);
        const p = new URLSearchParams({
          source:        'evening',
          eventSlug:     ev.slug,
          eventTitle:    ev.title,
          eventDate:     ev.starts_at.slice(0, 10),
          eventDisplay:  display,
          eventStart:    ev.starts_at,
          eventEnd:      ev.ends_at,
          eventLocation: ev.address_line || '',
          isPaid:        String(Boolean(ev.is_paid)),
          price:         String(Number(ev.price_per_person || 0)),
        });
        for (const [k, v] of prefill.entries()) p.set(k, v);
        const price = Number(ev.price_per_person || 0) === 0 ? 'Free' : `${ev.currency || 'CHF'} ${ev.price_per_person}`;
        return `
          <a href="book.html?${escapeHtml(p.toString())}" class="rebook-pill">
            <span class="rebook-pill__content">
              <span class="rebook-pill__title">${escapeHtml(ev.title)}</span>
              <span class="rebook-pill__meta">${escapeHtml(display)}</span>
            </span>
            <span class="rebook-pill__price">${escapeHtml(price)}</span>
          </a>`;
      }).join('');

      card.innerHTML = `
        <h1 class="rebook-title">Book an event</h1>
        <p class="rebook-subtitle">Choose an upcoming event.</p>
        <div class="rebook-list">${pills}</div>
        <a href="${escapeHtml(eveningsHref)}" class="rebook-browse">Browse all evenings →</a>
        ${renderActions()}
      `;
    }
  } catch (err) {
    renderError('Could not load options. Please try again in a moment.');
  }
})();
