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

describe('book submit error handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="booking-app"></div>'
    window.history.replaceState({}, '', '/book?type=intro')
    Element.prototype.scrollIntoView = vi.fn()
    window.siteClient = {
      config: {
        timezone: 'Europe/Zurich',
        turnstilePlaceholderToken: 'placeholder',
        defaultBookingPolicyLines: ['Booking policy'],
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

  it('shows the API error message when booking submission fails', async () => {
    evalCode("const SITE_CLIENT = window.siteClient || null;")
    evalCode(`
      function getPublicConfig() {
        return Promise.resolve({
          config_version: 'booking_policy_v1',
          booking_policy: { non_paid_confirmation_window_minutes: 1 },
          booking_policy_text: 'Booking policy',
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
      function bookingPayLater() {
        return Promise.reject({
          message: 'This slot is no longer available',
          data: { message: 'This slot is no longer available' },
        });
      }
    `)
    evalCode(bookSharedCode)
    evalCode(bookEffectsCode)
    evalCode(bookViewsCode)
    evalCode(bookPageCode)

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await flush()
    await flush()

    document.querySelector('.cal-day--available')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    document.querySelector('.time-slot')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    document.getElementById('f-first-name').value = 'P4'
    document.getElementById('f-first-name').dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('f-last-name').value = 'Loser'
    document.getElementById('f-last-name').dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('f-email').value = 'p4-conflict@example.test'
    document.getElementById('f-email').dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    document.querySelector('[data-submit]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()

    expect(document.querySelector('.form-error')?.textContent).toContain('This slot is no longer available')
  })
})
