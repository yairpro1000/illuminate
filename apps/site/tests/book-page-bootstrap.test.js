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

describe('book page bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="booking-app"></div>'
    window.history.replaceState({}, '', '/book?type=intro')
    window.siteClient = {
      config: {
        timezone: 'Europe/Zurich',
        turnstilePlaceholderToken: 'placeholder',
        defaultBookingPolicyLines: [
          'Booking policy',
          'First rule',
          'Second rule',
          'Contact me directly.',
        ],
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

  it('renders the intro booking UI after bootstrapping the full script stack', async () => {
    evalCode("const SITE_CLIENT = window.siteClient || null;")
    evalCode(`
      function getPublicConfig() {
        return Promise.resolve({
          config_version: 'booking_policy_v1',
          booking_policy: { non_paid_confirmation_window_minutes: 1 },
          booking_policy_text: 'Booking policy\\nFirst rule\\nSecond rule\\nContact me directly.',
        });
      }
      function getSlots() {
        return Promise.resolve({
          ok: true,
          timezone: 'Europe/Zurich',
          slots: [{
            type: 'intro',
            start: '2026-03-16T09:00:00+01:00',
            end: '2026-03-16T08:30:00.000Z',
          }],
        });
      }
    `)
    evalCode(bookSharedCode)
    evalCode(bookEffectsCode)
    evalCode(bookViewsCode)

    expect(() => evalCode(bookPageCode)).not.toThrow()

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await flush()
    await flush()

    expect(document.getElementById('booking-app').textContent).toContain('Book a Session')
    expect(document.querySelectorAll('.cal-day--available').length).toBeGreaterThan(0)
  })
})
