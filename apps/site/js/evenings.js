/* ============================================================
   ILLUMINATE Evenings — Event card renderer
   Fetches data/events_data.json and renders cards into #events-grid.
   Auto-sorts by date_iso ascending.
   ============================================================ */

(function initEventCards() {

  const grid = document.getElementById('events-grid');
  if (!grid) return;

  /* ── Helpers ────────────────────────────────────────────── */

  function formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  function eventEndIso(event) {
    const [h, m] = event.start_time.split(':').map(Number);
    const total  = h * 60 + m + event.duration_minutes;
    const pad    = n => String(n).padStart(2, '0');
    return event.date_iso + 'T' + pad(Math.floor(total / 60)) + ':' + pad(total % 60) + ':00';
  }

  function bookingUrl(event) {
    const params = new URLSearchParams({
      source:        'event',
      eventSlug:     event.id,
      eventTitle:    event.title,
      eventDate:     event.date_iso,
      eventDisplay:  event.date_display,
      eventStart:    event.date_iso + 'T' + event.start_time + ':00',
      eventEnd:      eventEndIso(event),
      eventLocation: event.location,
      isPaid:        'false',
    });
    return 'book?' + params.toString();
  }

  function dateBadge(dateIso) {
    const [, , day] = dateIso.split('-');
    const mon = new Date(dateIso + 'T12:00:00').toLocaleString('en-GB', { month: 'short' });
    return { day: parseInt(day, 10), mon };
  }

  /* ── Card template ──────────────────────────────────────── */

  function renderCard(event, index) {
    const badge   = dateBadge(event.date_iso);
    const dur     = formatDuration(event.duration_minutes);
    const url     = bookingUrl(event);
    const delay   = Math.min(index + 1, 5);
    const atcDesc = event.teaser + ' ' + event.description;

    const tags = event.tags
      .map(t => `<span class="event-tag">${t}</span>`)
      .join('');

    const atcWidget = typeof buildAtcWidget === 'function'
      ? buildAtcWidget({
          title:       event.title + ' — ILLUMINATE Evening',
          start:       event.date_iso + 'T' + event.start_time + ':00',
          end:         eventEndIso(event),
          location:    event.location,
          description: atcDesc,
        })
      : '';

    return `
      <article class="event-card fade-up fade-up--delay-${delay}" id="${event.id}" data-date="${event.date_iso}">

        <div class="event-card__image event-card__image--placeholder">
          <div class="event-card__date-badge">
            <span class="event-card__day">${badge.day}</span>
            <span class="event-card__month">${badge.mon}</span>
          </div>
        </div>

        <div class="event-card__body">
          <div class="event-card__tags">${tags}</div>

          <h3 class="event-card__title">${event.title}</h3>
          <p class="event-card__teaser">${event.teaser}</p>
          <p class="event-card__desc">${event.description}</p>

          <dl class="event-card__meta">
            <div class="event-card__meta-row">
              <dt>When</dt>
              <dd>${event.date_display} · ${event.start_time} (${dur})</dd>
            </div>
            <div class="event-card__meta-row">
              <dt>Where</dt>
              <dd>${event.location}</dd>
            </div>
            <div class="event-card__meta-row">
              <dt>Format</dt>
              <dd>${event.format}</dd>
            </div>
          </dl>

          <div class="event-card__actions">
            <a href="${url}" class="btn btn-primary">${event.cta_text}</a>
            ${atcWidget}
          </div>
        </div>

      </article>`;
  }

  /* ── Fetch & render ─────────────────────────────────────── */

  fetch('data/events_data.json')
    .then(r => r.json())
    .then(({ events }) => {
      // Sort ascending by date
      events.sort((a, b) => a.date_iso.localeCompare(b.date_iso));

      grid.innerHTML = events.map(renderCard).join('');

      // Wire up Add to Calendar widgets injected above
      if (typeof initAddToCalendar === 'function') initAddToCalendar(grid);

      // Scroll-reveal for dynamically added cards (main.js observer ran before these existed)
      const revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            entry.target.classList.toggle('is-visible', entry.isIntersecting);
          });
        },
        { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
      );
      grid.querySelectorAll('.fade-up').forEach(el => revealObserver.observe(el));
    })
    .catch(err => {
      console.error('[evenings.js] Could not load events_data.json:', err);
      grid.innerHTML = '<p class="events-error">Could not load upcoming events. Please try again later.</p>';
    });

})();
