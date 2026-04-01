import { beforeEach, describe, expect, it, vi } from 'vitest'
import bookSharedCode from '../js/book-shared.js?raw'
import bookEffectsCode from '../js/book-effects.js?raw'
import bookViewsCode from '../js/book-views.js?raw'
import bookPageCode from '../js/book.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// book.js captures BookPageEffects references at eval time (line ~30),
// so the mock must be in place before evalCode(bookPageCode).
function setupBookStack({ getSlots, rescheduleBooking, bookingRescheduleImpl }) {
  evalCode("const SITE_CLIENT = window.siteClient || null;")
  evalCode(`
    function getPublicConfig() {
      return Promise.resolve({
        config_version: 'booking_policy_v1',
        booking_policy: { non_paid_confirmation_window_minutes: 1 },
        booking_policy_text: 'Policy line.',
      });
    }
    function getSlots() {
      return (${JSON.stringify(getSlots)}) ? Promise.resolve(${JSON.stringify(getSlots)}) : Promise.resolve({ slots: [] });
    }
  `)
  window.bookingReschedule = bookingRescheduleImpl || vi.fn(async () => ({
    booking_id: 'bk-1',
    status: 'CONFIRMED',
    starts_at: '2026-05-10T11:00:00.000Z',
    ends_at: '2026-05-10T12:30:00.000Z',
  }))
  evalCode(bookSharedCode)
  evalCode(bookEffectsCode)
  evalCode(bookViewsCode)

  // Override loadRescheduleContext BEFORE evalCode(bookPageCode) so that
  // book.js captures our stub when it does:
  //   const loadRescheduleContext = BOOK_EFFECTS.loadRescheduleContext;
  window.BookPageEffects.loadRescheduleContext = async (args) => {
    if (args.context.mode !== 'reschedule') return
    const b = rescheduleBooking
    args.state.currentBooking = b
    args.state.firstName = b.client.first_name
    args.state.lastName  = b.client.last_name
    args.state.email     = b.client.email
    args.state.phone     = b.client.phone
    // Set calViewDate so day-slots view renders for the booking date.
    // Do NOT pre-select a slot — user must choose a new one.
    const d = new Date(b.starts_at)
    args.state.calViewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }

  evalCode(bookPageCode)
}

const BOOKING = {
  booking_id: 'bk-1',
  status: 'CONFIRMED',
  starts_at: '2026-05-10T09:00:00.000Z',
  ends_at:   '2026-05-10T10:30:00.000Z',
  client: { first_name: 'A', last_name: 'B', email: 'a@b.com', phone: '+41' },
}

describe('day slots empty state', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="booking-app"></div>'
    window.history.replaceState({}, '', '/book?type=session&mode=reschedule&token=tok-abc&id=bk-1')
    Element.prototype.scrollIntoView = vi.fn()
    window.siteClient = {
      config: {
        timezone: 'Europe/Zurich',
        turnstilePlaceholderToken: 'placeholder',
        defaultBookingPolicyLines: ['Policy line.'],
      },
    }
    window.siteObservability = {
      logMilestone: vi.fn(),
      logError: vi.fn(),
      getCorrelationId: () => 'cid_test',
      startFlow: () => 'cid_test',
    }
    window.initAddToCalendar = undefined
    window.buildAtcWidget = undefined
  })

  it('shows the empty-state message when the selected day has no available slots', async () => {
    setupBookStack({
      getSlots: { ok: true, timezone: 'Europe/Zurich', slots: [] },
      rescheduleBooking: BOOKING,
    })

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await flush()
    await flush()
    await flush()

    const emptyMsg = document.querySelector('.time-slots-empty')
    expect(emptyMsg).not.toBeNull()
    expect(emptyMsg.textContent.trim()).toContain('No times are available on this day')
    expect(emptyMsg.textContent.trim()).toContain('Please choose another day')
  })

  it('does not show the empty-state message when slots are available for the selected day', async () => {
    setupBookStack({
      getSlots: {
        ok: true,
        timezone: 'Europe/Zurich',
        slots: [
          { type: 'session', start: '2026-05-10T09:00:00.000Z', end: '2026-05-10T10:30:00.000Z' },
          { type: 'session', start: '2026-05-10T11:00:00.000Z', end: '2026-05-10T12:30:00.000Z' },
        ],
      },
      rescheduleBooking: BOOKING,
    })

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await flush()
    await flush()
    await flush()

    expect(document.querySelector('.time-slots-empty')).toBeNull()
    expect(document.querySelectorAll('.time-slot').length).toBeGreaterThan(0)
  })

  it('allows reschedule submission when turnstile is enabled but the flow has no turnstile widget', async () => {
    const bookingReschedule = vi.fn(async () => ({
      booking_id: 'bk-1',
      status: 'CONFIRMED',
      starts_at: '2026-05-10T11:00:00.000Z',
      ends_at: '2026-05-10T12:30:00.000Z',
    }))
    window.siteClient.config.turnstileEnabled = true

    setupBookStack({
      getSlots: {
        ok: true,
        timezone: 'Europe/Zurich',
        slots: [
          { type: 'session', start: '2026-05-10T11:00:00.000Z', end: '2026-05-10T12:30:00.000Z' },
        ],
      },
      rescheduleBooking: BOOKING,
      bookingRescheduleImpl: bookingReschedule,
    })

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await flush()
    await flush()
    await flush()

    document.querySelector('.time-slot')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    document.querySelector('[data-submit]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()

    expect(bookingReschedule).toHaveBeenCalledTimes(1)
    expect(document.getElementById('booking-app').textContent).toContain('Booking rescheduled')
  })
})
