/* ============================================================
   ILLUMINATE Evenings — Event renderer (API-driven)
   ============================================================ */

(function initEventCards() {
  const grid = document.getElementById('events-grid');
  const SITE_CLIENT = window.siteClient || null;
  const SITE_COUPON = window.SiteCoupon || null;
  if (!grid) return;
  const eventsLoadController = typeof AbortController === 'function' ? new AbortController() : null;
  let pageDisposing = false;
  let latestEvents = null;

  function markPageDisposing() {
    pageDisposing = true;
    eventsLoadController?.abort();
  }

  window.addEventListener('pagehide', markPageDisposing, { once: true });

  function isExpectedEventsLoadAbort(err) {
    if (pageDisposing || eventsLoadController?.signal.aborted) return true;
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return true;
    const message = err instanceof Error ? err.message : String(err || '');
    return pageDisposing && message.includes('Failed to fetch');
  }

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

  function formatTimeLabel(iso) {
    return new Date(iso).toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDateBadge(iso) {
    const date = new Date(iso);
    return {
      day: date.toLocaleString('en-GB', { day: '2-digit' }),
      month: date.toLocaleString('en-GB', { month: 'short' }).toUpperCase(),
    };
  }

  const R2_BASE = 'https://images.letsilluminate.co';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function eventImageUrl(event) {
    if (event.image_key) return `${R2_BASE}/${event.image_key}`;
    return '';
  }

  function formatDurationLabel(startIso, endIso) {
    const durationMinutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
    if (!durationMinutes) return '';
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    if (!hours) return `${minutes} min`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function normalizeMarketingList(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function getEventMarketingContent(event) {
    const marketing = event && typeof event.marketing_content === 'object' && event.marketing_content !== null
      ? event.marketing_content
      : {};
    const subtitle = String(marketing.subtitle || '').trim();
    const intro = String(marketing.intro || '').trim() || String(event.description || '').trim();
    const whatToExpect = normalizeMarketingList(marketing.what_to_expect);
    const takeaways = normalizeMarketingList(marketing.takeaways);

    return {
      subtitle,
      intro,
      whatToExpect,
      takeaways,
    };
  }

  function buildCalendarDescription(event, content) {
    const lines = [];
    if (content.subtitle) lines.push(content.subtitle);
    if (content.intro) lines.push(content.intro);
    if (content.whatToExpect.length) lines.push(`What to expect: ${content.whatToExpect.join('; ')}`);
    if (content.takeaways.length) lines.push(`You may leave with: ${content.takeaways.join('; ')}`);
    if (!lines.length && event.description) lines.push(String(event.description).trim());
    return lines.join('\n\n');
  }

  function formatPrice(event) {
    if (!event.is_paid) return 'Free';
    if (SITE_COUPON && typeof SITE_COUPON.buildPriceHtml === 'function') {
      return SITE_COUPON.buildPriceHtml(event.price_per_person, event.currency || 'CHF');
    }
    const amount = Math.round(Number(event.price_per_person || 0) * 100) / 100;
    const currency = event.currency || 'CHF';
    return `${currency} ${Number.isInteger(amount) ? String(amount) : amount.toFixed(2)}`;
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
      price: String(Number(event.price_per_person || 0)),
    });

    return 'book.html?' + params.toString();
  }

  function reminderForm(eventId) {
    return `
      <form class="event-reminder-form" data-reminder-form="${escapeAttr(eventId)}" hidden>
        <label class="visually-hidden" for="reminder-email-${escapeAttr(eventId)}">Email</label>
        <input id="reminder-email-${escapeAttr(eventId)}" type="email" name="email" placeholder="your@email.com" required />
        <input type="text" name="first_name" placeholder="First name (optional)" />
        <input type="text" name="last_name" placeholder="Last name (optional)" />
        <button type="submit" class="btn btn-primary">Join reminders</button>
        <p class="event-reminder-msg" data-reminder-msg="${escapeAttr(eventId)}" aria-live="polite"></p>
      </form>
    `;
  }

  function renderFact(label, value, modifier) {
    return `
      <div class="event-card__fact${modifier ? ` event-card__fact--${modifier}` : ''}">
        <span class="event-card__fact-label">${label}</span>
        <span class="event-card__fact-value">${value}</span>
      </div>
    `;
  }

  function renderInfoList(title, items) {
    if (!items.length) return '';
    return `
      <section class="event-card__section" aria-label="${escapeAttr(title)}">
        <p class="event-card__section-label">${escapeHtml(title)}</p>
        <ul class="event-card__list">
          ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </section>
    `;
  }

  function renderCard(event, isPast) {
    const render = event.render || {};
    const soldOut = Boolean(render.sold_out);
    const publicOpen = Boolean(render.public_registration_open);
    const showReminder = Boolean(render.show_reminder_signup_cta);
    const dateBadge = formatDateBadge(event.starts_at);
    const content = getEventMarketingContent(event);
    const durationLabel = formatDurationLabel(event.starts_at, event.ends_at);
    const seatsLeft = (() => {
      const cap = Number(event.stats?.capacity ?? event.capacity ?? 0);
      const booked = Number(event.stats?.active_bookings ?? 0);
      const left = cap - booked;
      return left > 0 && left <= 5 ? left : null;
    })();

    const badge = soldOut
      ? '<span class="event-tag event-tag--sold-out">Sold out</span>'
      : isPast
        ? '<span class="event-tag">Past event</span>'
        : '<span class="event-tag">Upcoming</span>';

    let actionHtml = '';
    if (publicOpen) {
      actionHtml = `<a href="${bookingUrl(event)}" class="btn btn-primary event-card__cta-primary">Book your spot</a>`;
    } else if (showReminder) {
      actionHtml = `<button class="btn btn-secondary" data-open-reminder="${escapeAttr(event.id)}">Join reminders list</button>`;
    } else {
      actionHtml = '<span class="btn btn-ghost" aria-disabled="true">Registration closed</span>';
    }

    const atcWidget = (!isPast && typeof buildAtcWidget === 'function')
      ? buildAtcWidget({
          title: `${event.title} — ILLUMINATE Evening`,
          start: event.starts_at,
          end: event.ends_at,
          location: event.address_line,
          description: buildCalendarDescription(event, content),
        })
      : '';

    return `
      <article class="event-card fade-up" id="${escapeAttr(event.slug)}">
        <div class="event-card__image">
          <img
            class="event-card__img"
            src="${escapeAttr(eventImageUrl(event))}"
            alt="${escapeAttr(event.title)}"
            loading="lazy"
            decoding="async"
            onerror="this.parentElement.classList.add('event-card__image--placeholder'); this.removeAttribute('onerror');"
          />
          <div class="event-card__date-badge" aria-hidden="true">
            <span class="event-card__day">${dateBadge.day}</span>
            <span class="event-card__month">${dateBadge.month}</span>
          </div>
        </div>
        <div class="event-card__body">
          <div class="event-card__tags">${badge}</div>
          <header class="event-card__header">
            <h3 class="event-card__title">${escapeHtml(event.title)}</h3>
            ${content.subtitle ? `<p class="event-card__subtitle">${escapeHtml(content.subtitle)}</p>` : ''}
          </header>

          <div class="event-card__facts">
            ${renderFact('When', `${escapeHtml(formatDateLabel(event.starts_at))}`, 'wide')}
            ${renderFact('Time', `${escapeHtml(formatTimeLabel(event.starts_at))}${durationLabel ? ` <span class="event-card__fact-meta">${escapeHtml(durationLabel)}</span>` : ''}`)}
            ${renderFact('Where', escapeHtml(event.address_line), 'wide')}
            ${renderFact('Price', formatPrice(event))}
            ${seatsLeft ? renderFact('Seats left', escapeHtml(String(seatsLeft)), 'emphasis') : ''}
          </div>

          ${content.intro ? `<p class="event-card__intro">${escapeHtml(content.intro)}</p>` : ''}
          ${renderInfoList('What to expect', content.whatToExpect)}
          ${renderInfoList('You may leave with', content.takeaways)}

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
            await SITE_CLIENT.requestJson('/api/events/reminder-subscriptions', {
              method: 'POST',
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
    latestEvents = Array.isArray(events) ? events : null;
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

  window.addEventListener('sitecouponchange', () => {
    if (!Array.isArray(latestEvents)) return;
    renderSections(latestEvents);
  });

  SITE_CLIENT.requestJson('/api/events', {
    signal: eventsLoadController?.signal,
  })
    .then((data) => {
      if (pageDisposing) return;
      const events = Array.isArray(data.events) ? data.events : [];
      events.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
      renderSections(events);
    })
    .catch((err) => {
      if (isExpectedEventsLoadAbort(err)) return;
      console.error('[evenings.js] Could not load events:', err);
      grid.innerHTML = '<p class="events-error">Could not load events. Please try again later.</p>';
    });
})();
