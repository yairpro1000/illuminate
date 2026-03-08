/* ============================================================
   ILLUMINATE — API client
   All calls go to the Cloudflare Worker at /api/*.
   PROVIDERS_MODE on the Worker controls mock vs real behaviour
   — no client-side mock flag needed.
   ============================================================ */

'use strict';

/* ── Slot availability ───────────────────────────────────── */

/**
 * GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=...&type=intro|session
 */
function getSlots(from, to, type, tz = 'Europe/Zurich') {
  const params = new URLSearchParams({ from, to, type, tz });
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

/* ── Event registrations ─────────────────────────────────── */

/**
 * POST /api/events/:slug/register
 * Returns: { ok, registration_id, status, checkout_url? }
 */
function eventRegister(slug, payload) {
  // Strip internal-only fields before sending
  const { _isPaid, ...body } = payload;
  return _post('/api/events/' + encodeURIComponent(slug) + '/register', body);
}

/* ── Base URL ─────────────────────────────────────────────
   In production (Cloudflare Pages + Worker on same domain)
   relative paths work fine — leave as empty string.
   In local dev, set this to the Worker's address so the
   site on :8080 can reach the Worker on :8787.
   Override via: localStorage.setItem('API_BASE', 'http://localhost:8787')
   ──────────────────────────────────────────────────────── */

const API_BASE = localStorage.getItem('API_BASE') ||
  (location.hostname === 'localhost' ? 'http://localhost:8787' : '');

/* ── Internal fetch helpers ──────────────────────────────── */

async function _get(path) {
  const res = await fetch(API_BASE + path);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'API error'), { status: res.status, data });
  return data;
}

async function _post(path, body) {
  const res = await fetch(API_BASE + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'API error'), { status: res.status, data });
  return data;
}
