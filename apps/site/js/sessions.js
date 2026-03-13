/* ============================================================
   ILLUMINATE — Sessions page: dynamic session type cards
   Data source: GET /api/session-types
   Fallback:    /fallback_local_data/session_types.json
   ============================================================ */
'use strict';

(function () {
  const SITE_CLIENT = window.siteClient || null;

  const FALLBACK_URL = '/fallback_local_data/session_types.json';
  const DELAY_CLASSES = ['', ' fade-up--delay-1', ' fade-up--delay-2', ' fade-up--delay-3'];

  /* ── Price display ─────────────────────────────────────── */
  function fmtPrice(price, currency) {
    if (price === 0) return 'Free';
    return currency + ' ' + price;
  }

  /* ── Strip the trailing "Format: …" sentence from description ── */
  function stripFormat(description) {
    return description.replace(/\s*Format:.*$/i, '').trim();
  }

  /* ── Map slug to the booking URL type param ──────────────
     Preserves compatibility with the existing booking flow. */
  function bookingHref(slug) {
    if (slug === 'intro-clarity-conversation') {
      return 'book.html?type=intro';
    }
    return 'book.html?type=session&offer=' + encodeURIComponent(slug);
  }

  /* ── Build a single session card element ─────────────── */
  function buildCard(session, index) {
    const delayClass = DELAY_CLASSES[index % DELAY_CLASSES.length] || '';

    const article = document.createElement('article');
    article.className = 'event-card fade-up' + delayClass;

    const body = document.createElement('div');
    body.className = 'event-card__body';

    // Tags: price + duration
    const tags = document.createElement('div');
    tags.className = 'event-card__tags';
    const priceTag = document.createElement('span');
    priceTag.className = 'event-tag';
    priceTag.textContent = fmtPrice(session.price, session.currency);
    const durTag = document.createElement('span');
    durTag.className = 'event-tag';
    durTag.textContent = session.duration_minutes + ' min';
    tags.appendChild(priceTag);
    tags.appendChild(durTag);

    // Title
    const h3 = document.createElement('h3');
    h3.className = 'event-card__title';
    h3.textContent = session.title;

    // Short description (teaser)
    const teaser = document.createElement('p');
    teaser.className = 'event-card__teaser';
    teaser.textContent = session.short_description || '';

    // Full description (format line stripped)
    const desc = document.createElement('p');
    desc.className = 'event-card__desc';
    desc.textContent = stripFormat(session.description);

    // Meta rows
    const dl = document.createElement('dl');
    dl.className = 'event-card__meta';
    dl.appendChild(metaRow('Duration', session.duration_minutes + ' min'));
    dl.appendChild(metaRow('Investment', fmtPrice(session.price, session.currency)));
    dl.appendChild(metaRow('Format', 'Online or in person · Lugano'));

    // CTA
    const actions = document.createElement('div');
    actions.className = 'event-card__actions session-card__actions';
    const btn = document.createElement('a');
    btn.href = bookingHref(session.slug);
    btn.className = 'btn btn-primary';
    btn.textContent = 'Book this session';
    actions.appendChild(btn);

    body.appendChild(tags);
    body.appendChild(h3);
    body.appendChild(teaser);
    body.appendChild(desc);
    body.appendChild(dl);
    body.appendChild(actions);
    article.appendChild(body);
    return article;
  }

  function metaRow(label, value) {
    const row = document.createElement('div');
    row.className = 'event-card__meta-row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  /* ── Render sessions into the grid ──────────────────────── */
  function renderSessions(sessions, grid) {
    grid.innerHTML = '';
    if (!sessions || !sessions.length) {
      const msg = document.createElement('p');
      msg.className = 'sessions-intro';
      msg.textContent = 'No sessions are currently available.';
      grid.appendChild(msg);
      return;
    }
    sessions.forEach(function (session, i) {
      grid.appendChild(buildCard(session, i));
    });

    const revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          entry.target.classList.toggle('is-visible', entry.isIntersecting);
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
    );
    grid.querySelectorAll('.fade-up').forEach(function (el) { revealObserver.observe(el); });
  }

  /* ── Resolve the API base URL (mirrors api.js logic) ────── */
  /* ── Fetch with fallback ──────────────────────────────── */
  async function fetchSessionTypes() {
    // Try the live API first
    try {
      const data = await SITE_CLIENT.requestJson('/api/session-types');
      if (Array.isArray(data.session_types)) return data.session_types;
    } catch (_) {
      // API unavailable — fall through to local fallback
    }

    // Local fallback — only in local dev, never in production
    const localHosts = ['localhost', '127.0.0.1', '::1'];
    if (localHosts.indexOf(location.hostname) === -1) {
      throw new Error('API unavailable');
    }
    const res = await fetch(FALLBACK_URL);
    if (!res.ok) throw new Error('Fallback data unavailable');
    return res.json();
  }

  /* ── Init ─────────────────────────────────────────────── */
  async function init() {
    const grid = document.getElementById('sessionGrid');
    if (!grid) return;

    try {
      const sessions = await fetchSessionTypes();
      renderSessions(sessions, grid);
    } catch (err) {
      grid.innerHTML = '';
      const msg = document.createElement('p');
      msg.className = 'sessions-intro';
      msg.textContent = 'Unable to load sessions. Please try again later.';
      grid.appendChild(msg);
    }
  }

  init();

})();
