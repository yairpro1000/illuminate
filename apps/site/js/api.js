/* ============================================================
  ILLUMINATE — API client
  All calls go to the backend Worker under /api/*.
  API base selection:
  - local override: localStorage.API_BASE
  - env (if provided): window.ENV.VITE_API_BASE
  - localhost: http://localhost:8788
  - production default: https://api.letsilluminate.co
  ============================================================ */

'use strict';

/* ── Session types ───────────────────────────────────────── */

/**
 * GET /api/session-types
 * Returns: { session_types: SessionType[] }
 */
function getSessionTypes() {
  return _get('/api/session-types');
}

/**
 * GET /api/config
 * Returns: { config_version, booking_policy }
 */
function getPublicConfig() {
  return _get('/api/config');
}

/**
 * POST /api/coupons/validate
 * Returns: { coupon: { code, discount_percent } }
 */
function validateCoupon(code) {
  return _post('/api/coupons/validate', { code });
}

/* ── Slot availability ───────────────────────────────────── */

/**
 * GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=...&type=intro|session&offer_slug=...
 */
function getSlots(from, to, type, tz = 'Europe/Zurich', offerSlug = '', sessionTypeId = '') {
  // Always send a valid type; backend requires it.
  const slotType = type === 'session' ? 'session' : 'intro';
  const params = new URLSearchParams({ from, to, tz });
  params.set('type', slotType);
  if (offerSlug) params.set('offer_slug', offerSlug);
  if (sessionTypeId) params.set('session_type_id', sessionTypeId);
  return _get('/api/slots?' + params.toString());
}

/* ── 1:1 Bookings ────────────────────────────────────────── */

/**
 * POST /api/bookings/pay-now
 * Returns: { ok, booking_id, checkout_url, checkout_hold_expires_at }
 */
function bookingPayNow(payload) {
  return _post('/api/bookings/pay-now', payload);
}

/**
 * POST /api/bookings/pay-later
 * Returns: { ok, booking_id, status: 'pending_email' }
 */
function bookingPayLater(payload) {
  return _post('/api/bookings/pay-later', payload);
}

/**
 * POST /api/bookings/reschedule
 * Returns: { ok, booking_id, status, starts_at, ends_at, timezone }
 */
function bookingReschedule(payload) {
  return _post('/api/bookings/reschedule', payload);
}

async function pollBookingEventStatus(bookingEvent, token, adminToken, options) {
  const eventId = bookingEvent && bookingEvent.id ? String(bookingEvent.id) : '';
  if (!eventId || !token) throw new Error('booking_event_id and token are required');
  const intervalMs = options && Number.isFinite(options.intervalMs) ? Math.max(100, Number(options.intervalMs)) : 500;
  const timeoutMs = options && Number.isFinite(options.timeoutMs) ? Math.max(intervalMs, Number(options.timeoutMs)) : 12_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const params = new URLSearchParams({
      booking_event_id: eventId,
      token: String(token),
    });
    if (adminToken) params.set('admin_token', String(adminToken));

    const snapshot = await requestJson('GET', '/api/bookings/event-status?' + params.toString());
    if (snapshot.is_terminal) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw Object.assign(new Error('BOOKING_EVENT_STATUS_TIMEOUT'), { code: 'BOOKING_EVENT_STATUS_TIMEOUT' });
}

/* ── Event bookings ──────────────────────────────────────── */

/**
 * POST /api/events/:slug/book
 * Returns: { booking_id, status, checkout_url? }
 */
function eventBook(slug, payload) {
  return _post('/api/events/' + encodeURIComponent(slug) + '/book', payload);
}

/**
 * POST /api/events/:slug/book-with-access
 * Returns: { booking_id, status, checkout_url? }
 */
function eventBookWithAccess(slug, payload) {
  return _post('/api/events/' + encodeURIComponent(slug) + '/book-with-access', payload);
}

/**
 * POST /api/events/reminder-subscriptions
 * Returns: { id, email, event_family }
 */
function createEventReminderSubscription(payload) {
  return _post('/api/events/reminder-subscriptions', payload);
}

/* ── Base URL ───────────────────────────────────────────── */
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SITE_CLIENT = window.siteClient || null;
// Prefer precomputed global base (from js/api-base.js) when available.
const ENV_BASE = (window.ENV && window.ENV.VITE_API_BASE) || undefined;
const DEFAULT_LOCAL = 'http://localhost:8788';
const DEFAULT_PROD  = 'https://api.letsilluminate.co';
const API_BASE = (function computeApiBase() {
  if (SITE_CLIENT && typeof SITE_CLIENT.getApiBase === 'function') return SITE_CLIENT.getApiBase().replace(/\/+$/g, '');
  if (typeof window !== 'undefined' && window.API_BASE) return window.API_BASE.replace(/\/+$/g, '');
  const fromStorage = (function(){ try { return localStorage.getItem('API_BASE') || null; } catch (_) { return null; } })();
  if (fromStorage && fromStorage.trim()) return fromStorage.replace(/\/+$/g, '');
  if (ENV_BASE && String(ENV_BASE).trim()) return String(ENV_BASE).replace(/\/+$/g, '');
  if (LOCAL_DEV_HOSTS.has(location.hostname)) return DEFAULT_LOCAL;
  return DEFAULT_PROD;
})();
const OBS = window.siteObservability || null;

/* ── Internal fetch helpers ──────────────────────────────── */

async function _get(path) {
  return requestJson('GET', path);
}

async function _post(path, body) {
  return requestJson('POST', path, body);
}

async function requestJson(method, path, body) {
  const _sp = window.siteSpinner;
  if (_sp) _sp.show();
  try {
  const url = API_BASE + path;
  const requestId = (crypto.randomUUID && crypto.randomUUID()) || ('rid_' + Date.now().toString(36));
  const correlationId = OBS && OBS.getCorrelationId ? OBS.getCorrelationId() : requestId;
  const startedAt = Date.now();
  const uiTestMode = SITE_CLIENT && typeof SITE_CLIENT.detectUiTestMode === 'function'
    ? SITE_CLIENT.detectUiTestMode()
    : (typeof navigator !== 'undefined' && navigator.webdriver ? 'playwright' : null);
  const res = await fetch(API_BASE + path, {
    method:  method,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-correlation-id': correlationId,
      ...(uiTestMode ? { 'x-illuminate-ui-test-mode': uiTestMode } : {}),
    },
    body:    body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await parseApiResponseBody(res);
  } catch (error) {
    if (OBS) {
      OBS.logError({
        eventType: 'request_failure',
        message: method + ' ' + path,
        requestId: requestId,
        correlationId: correlationId,
        api: {
          direction: 'outbound',
          provider: 'site_api',
          method: method,
          url: url,
          path: path,
          statusCode: res.status,
          durationMs: Date.now() - startedAt,
          success: false,
          requestSizeBytes: body ? JSON.stringify(body).length : 0,
        },
        apiFailure: {
          responseBody: String(error && error.message || error),
          redactionNote: 'Frontend previews are truncated and secret headers are omitted.',
        },
      });
    }
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  if (OBS) {
    const success = res.ok;
    const payload = {
      eventType: success ? 'request' : 'request_failure',
      message: method + ' ' + path,
      requestId: requestId,
      correlationId: correlationId,
      api: {
        direction: 'outbound',
        provider: 'site_api',
        method: method,
        url: url,
        path: path,
        statusCode: res.status,
        durationMs: durationMs,
        success: success,
        requestSizeBytes: body ? JSON.stringify(body).length : 0,
        responseSizeBytes: JSON.stringify(data || {}).length,
      },
    };

    if (success) OBS.logInfo(payload);
    else OBS.logError(Object.assign({}, payload, {
      apiFailure: {
        responseBody: data,
        redactionNote: 'Frontend previews are truncated and secret headers are omitted.',
      },
    }));
  }

  if (!res.ok) throw Object.assign(new Error(data.message || 'API error'), { status: res.status, data });
  if (SITE_CLIENT && typeof SITE_CLIENT.maybeRenderMockEmailPreview === 'function') {
    await SITE_CLIENT.maybeRenderMockEmailPreview(data);
  }
  return data;
  } finally {
    if (_sp) _sp.hide();
  }
}

async function parseApiResponseBody(res) {
  if (SITE_CLIENT && typeof SITE_CLIENT.parseJsonishResponse === 'function') {
    return SITE_CLIENT.parseJsonishResponse(res);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) return res.json();

  const text = await res.text();
  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksLikeJson) {
    try { return JSON.parse(text); } catch (_) { /* handled below */ }
  }

  throw Object.assign(
    new Error('API returned non-JSON response (likely wrong API host or route).'),
    { status: res.status, data: { message: text.slice(0, 180) } },
  );
}

window.pollBookingEventStatus = pollBookingEventStatus;
