import { beforeEach, describe, expect, it, vi } from 'vitest'
import turnstileCode from '../js/turnstile.js?raw'
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

describe('booking turnstile integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="booking-app"></div>'
    window.history.replaceState({}, '', '/book?type=intro')
    Element.prototype.scrollIntoView = vi.fn()
    window.SiteTurnstile = undefined
    window.turnstile = undefined
    window.siteClient = {
      config: {
        timezone: 'Europe/Zurich',
        antibotMode: 'mock',
        turnstileEnabled: false,
        turnstileSiteKey: null,
        turnstileLoadError: null,
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

  it('shows the visible turnstile block on the booking review step when public config enables it', async () => {
    evalCode("const SITE_CLIENT = window.siteClient || null;")
    evalCode(`
      function getPublicConfig() {
        return Promise.resolve({
          config_version: 'booking_policy_v1',
          booking_policy: { non_paid_confirmation_window_minutes: 1 },
          booking_policy_text: 'Booking policy',
          antibot: {
            mode: 'turnstile',
            turnstile: {
              enabled: true,
              site_key: '0x4AAAA-real-key',
            },
          },
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

    evalCode(turnstileCode)
    const renderVisibleWidget = vi.fn().mockResolvedValue(undefined)
    window.SiteTurnstile.renderVisibleWidget = renderVisibleWidget

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

    document.getElementById('f-first-name').value = 'Yair'
    document.getElementById('f-first-name').dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('f-last-name').value = 'Test'
    document.getElementById('f-last-name').dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('f-email').value = 'yair@example.com'
    document.getElementById('f-email').dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()

    expect(document.querySelector('.turnstile-inline')).not.toBeNull()
    expect(document.querySelector('[data-turnstile-host="booking_submit"]')).not.toBeNull()
    expect(renderVisibleWidget).toHaveBeenCalledTimes(1)
    expect(renderVisibleWidget.mock.calls[0][0].config.turnstileEnabled).toBe(true)
    expect(renderVisibleWidget.mock.calls[0][0].config.turnstileSiteKey).toBe('0x4AAAA-real-key')
  })
})
