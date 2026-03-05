/* ============================================================
   ILLUMINATE — Placeholder API client
   Stubs matching Cloudflare Worker endpoint contracts.
   Swap each Promise.resolve() body for real fetch() when workers go live.
   ============================================================ */

'use strict';

/* ── Slot availability ───────────────────────────────────── */

/**
 * GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=...
 */
function getSlots(from, to, tz = 'Europe/Zurich') {
  console.log('[API placeholder] getSlots', { from, to, tz });
  return Promise.resolve({
    timezone: tz,
    slots: _generatePlaceholderSlots(from, to),
  });
}

/* ── 1:1 Bookings ────────────────────────────────────────── */

/**
 * POST /api/bookings/pay-now
 */
function bookingPayNow(payload) {
  console.log('[API placeholder] POST /api/bookings/pay-now', payload);
  return Promise.resolve({
    ok: true,
    booking_id: _demoId(),
    checkout_url: 'https://checkout.stripe.com/placeholder',
    checkout_hold_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
}

/**
 * POST /api/bookings/pay-later
 */
function bookingPayLater(payload) {
  console.log('[API placeholder] POST /api/bookings/pay-later', payload);
  return Promise.resolve({
    ok: true,
    booking_id: _demoId(),
    status: 'pending_email',
  });
}

/* ── Event registrations ─────────────────────────────────── */

/**
 * POST /api/events/:slug/register
 * payload._isPaid: boolean (internal flag, stripped before sending to real API)
 */
function eventRegister(slug, payload) {
  console.log('[API placeholder] POST /api/events/' + slug + '/register', payload);
  const isPaid = !!payload._isPaid;
  const result = {
    ok: true,
    registration_id: _demoId(),
    status: isPaid ? 'pending_payment' : 'pending_email',
  };
  if (isPaid) {
    result.checkout_url = 'https://checkout.stripe.com/placeholder';
    result.checkout_hold_expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }
  return Promise.resolve(result);
}

/* ── Internal helpers ────────────────────────────────────── */

function _demoId() {
  return 'demo_' + Math.random().toString(36).slice(2, 9);
}

/**
 * Generates realistic-looking placeholder slot data for the given date range.
 * ~66% of weekdays have availability; ~80% of those have all 4 time slots.
 */
function _generatePlaceholderSlots(from, to) {
  const slots = [];
  const slotTimes = [
    { h: 9,  m: 0  },
    { h: 11, m: 0  },
    { h: 14, m: 30 },
    { h: 16, m: 30 },
  ];

  const cur = new Date(from + 'T12:00:00');
  const end = new Date(to   + 'T12:00:00');

  while (cur <= end) {
    const dow = cur.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      const d = cur.getDate();
      if (d % 3 !== 0) { // ~66% of weekdays have slots
        const ymd = cur.toISOString().slice(0, 10);
        slotTimes.forEach(({ h, m }) => {
          if ((d + h) % 5 !== 0) { // ~80% of time slots per available day
            const pad = n => String(n).padStart(2, '0');
            slots.push({
              start: ymd + 'T' + pad(h) + ':' + pad(m) + ':00+01:00',
              end:   ymd + 'T' + pad(h + 1) + ':' + pad(m) + ':00+01:00',
            });
          }
        });
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  return slots;
}
