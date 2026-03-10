/* ============================================================
   ILLUMINATE Evenings — Event renderer (API-driven)
   ============================================================ */

(function initEventCards() {
  const grid = document.getElementById('events-grid');
  if (!grid) return;

  function formatDateLabel(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatPrice(event) {
    if (!event.is_paid) return 'Free';
    const cents = Number(event.price_per_person_cents || 0);
    const currency = event.currency || 'CHF';
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }

  function bookingUrl(event) {
    const params = new URLSearchParams({
      source: 'evening',
      eventSlug: event.slug,
      eventTitle: event.title,
      eventDate: event.starts_at.slice(0, 10),
      eventDisplay: formatDateLabel(event.starts_at),
      eventStart: event.starts_at,
      eventEnd: event.ends_at,
      eventLocation: event.address_line,
      isPaid: String(Boolean(event.is_paid)),
      price: String(Number(event.price_per_person_cents || 0)),
    });

    return 'book.html?' + params.toString();
  }

  function reminderForm(eventId) {
    return `
      <form class="event-reminder-form" data-reminder-form="${eventId}" hidden>
        <label class="visually-hidden" for="reminder-email-${eventId}">Email</label>
        <input id="reminder-email-${eventId}" type="email" name="email" placeholder="your@email.com" required />
        <input type="text" name="first_name" placeholder="First name (optional)" />
        <input type="text" name="last_name" placeholder="Last name (optional)" />
        <button type="submit" class="btn btn-primary">Join reminders</button>
        <p class="event-reminder-msg" data-reminder-msg="${eventId}" aria-live="polite"></p>
      </form>
    `;
  }

  function renderCard(event, isPast) {
    const render = event.render || {};
    const soldOut = Boolean(render.sold_out);
    const publicOpen = Boolean(render.public_registration_open);
    const showReminder = Boolean(render.show_reminder_signup_cta);

    const badge = soldOut
      ? '<span class="event-tag">Sold out</span>'
      : isPast
        ? '<span class="event-tag">Past event</span>'
        : '<span class="event-tag">Upcoming</span>';

    let actionHtml = '';
    if (publicOpen) {
      actionHtml = `<a href="${bookingUrl(event)}" class="btn btn-primary">Book your spot</a>`;
    } else if (showReminder) {
      actionHtml = `<button class="btn btn-primary" data-open-reminder="${event.id}">Join reminders list</button>`;
    } else {
      actionHtml = '<span class="btn btn-ghost" aria-disabled="true">Registration closed</span>';
    }

    const atcWidget = (!isPast && typeof buildAtcWidget === 'function')
      ? buildAtcWidget({
          title: `${event.title} — ILLUMINATE Evening`,
          start: event.starts_at,
          end: event.ends_at,
          location: event.address_line,
          description: event.description,
        })
      : '';

    return `
      <article class="event-card fade-up" id="${event.slug}">
        <div class="event-card__body">
          <div class="event-card__tags">${badge}</div>
          <h3 class="event-card__title">${event.title}</h3>
          <p class="event-card__teaser">${event.description}</p>

          <dl class="event-card__meta">
            <div class="event-card__meta-row"><dt>When</dt><dd>${formatDateLabel(event.starts_at)}</dd></div>
            <div class="event-card__meta-row"><dt>Where</dt><dd>${event.address_line}</dd></div>
            <div class="event-card__meta-row"><dt>Price</dt><dd>${formatPrice(event)}</dd></div>
            <div class="event-card__meta-row"><dt>Capacity</dt><dd>${event.stats?.active_bookings ?? 0}/${event.stats?.capacity ?? event.capacity}</dd></div>
          </dl>

          <div class="event-card__actions">
            ${actionHtml}
            ${atcWidget}
          </div>

          ${showReminder ? reminderForm(event.id) : ''}
        </div>
      </article>
    `;
  }

  function attachReminderHandlers(container) {
    container.querySelectorAll('[data-open-reminder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const eventId = btn.getAttribute('data-open-reminder');
        const form = container.querySelector(`[data-reminder-form="${eventId}"]`);
        if (!form) return;
        form.hidden = !form.hidden;
      });
    });

    container.querySelectorAll('[data-reminder-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const eventId = form.getAttribute('data-reminder-form');
        const msg = container.querySelector(`[data-reminder-msg="${eventId}"]`);
        const fd = new FormData(form);
        const payload = {
          email: String(fd.get('email') || '').trim(),
          first_name: String(fd.get('first_name') || '').trim() || null,
          last_name: String(fd.get('last_name') || '').trim() || null,
          event_family: 'illuminate_evenings',
        };

        try {
          if (typeof createEventReminderSubscription === 'function') {
            await createEventReminderSubscription(payload);
          } else {
            const base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
            await fetch(base + '/api/events/reminder-subscriptions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          }
          if (msg) msg.textContent = 'You are on the reminders list.';
          form.reset();
        } catch (err) {
          if (msg) msg.textContent = 'Could not save reminder signup. Please try again.';
        }
      });
    });
  }

  function renderSections(events) {
    const future = events.filter((e) => !(e.render && e.render.is_past));
    const past = events.filter((e) => Boolean(e.render && e.render.is_past));

    const futureCards = future.length
      ? future.map((e) => renderCard(e, false)).join('')
      : '<p class="events-empty">No upcoming evenings yet — check back soon.</p>';

    const pastCards = past.length
      ? past.map((e) => renderCard(e, true)).join('')
      : '<p class="events-empty">No past evenings yet.</p>';

    grid.innerHTML = `
      <div class="events-tabs">
        <div class="events-tabs__nav" role="tablist" aria-label="Event categories">
          <button class="events-tabs__tab is-active" role="tab" aria-selected="true" aria-controls="tab-upcoming" id="btn-upcoming">
            Upcoming${future.length ? ` <span class="events-tabs__count">${future.length}</span>` : ''}
          </button>
          <button class="events-tabs__tab" role="tab" aria-selected="false" aria-controls="tab-past" id="btn-past">
            Past Evenings${past.length ? ` <span class="events-tabs__count">${past.length}</span>` : ''}
          </button>
        </div>
        <div class="events-tabs__panel" id="tab-upcoming" role="tabpanel" aria-labelledby="btn-upcoming">
          <div class="events-grid">${futureCards}</div>
        </div>
        <div class="events-tabs__panel" id="tab-past" role="tabpanel" aria-labelledby="btn-past" hidden>
          <div class="events-grid">${pastCards}</div>
        </div>
      </div>
    `;

    // Wire up tab switching
    const tabs = grid.querySelectorAll('.events-tabs__tab');
    const panels = grid.querySelectorAll('.events-tabs__panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
        panels.forEach((p) => { p.hidden = true; });
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
        const panel = grid.querySelector('#' + tab.getAttribute('aria-controls'));
        if (panel) panel.hidden = false;
      });
    });

    if (typeof initAddToCalendar === 'function') initAddToCalendar(grid);

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle('is-visible', entry.isIntersecting);
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    grid.querySelectorAll('.fade-up').forEach((el) => revealObserver.observe(el));

    attachReminderHandlers(grid);
  }

  (function(){
    const base = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
    return fetch(base + '/api/events');
  })()
    .then((r) => r.json())
    .then((data) => {
      const events = Array.isArray(data.events) ? data.events : [];
      events.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
      renderSections(events);
    })
    .catch((err) => {
      console.error('[evenings.js] Could not load events:', err);
      grid.innerHTML = '<p class="events-error">Could not load events. Please try again later.</p>';
    });
})();
