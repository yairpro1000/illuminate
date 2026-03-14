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

  it('replaces the submit action with a recovery path when the chosen slot is taken', async () => {
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

    expect(document.querySelector('[data-submit]')).toBeNull()
    expect(document.querySelector('.booking-recovery__title')?.textContent).toContain('That time was just taken')
    expect(document.querySelector('[data-repick-slot]')?.textContent).toContain('Choose another time')
    expect(document.querySelector('.booking-recovery__stale-slot strong')?.textContent).toContain('09:00')
  })

  it('returns the user to slot selection and preserves entered details after choosing another time', async () => {
    evalCode("const SITE_CLIENT = window.siteClient || null;")
    evalCode(`
      let slotCall = 0;
      function getPublicConfig() {
        return Promise.resolve({
          config_version: 'booking_policy_v1',
          booking_policy: { non_paid_confirmation_window_minutes: 1 },
          booking_policy_text: 'Booking policy',
        });
      }
      function getSlots() {
        slotCall += 1;
        if (slotCall === 1) {
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
        return Promise.resolve({
          ok: true,
          timezone: 'Europe/Zurich',
          slots: [{
            type: 'intro',
            start: '2026-03-16T10:00:00+01:00',
            end: '2026-03-16T09:30:00.000Z',
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

    document.querySelector('[data-repick-slot]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()

    expect(document.querySelector('.time-slots')).not.toBeNull()
    expect(document.querySelector('.time-slot')?.textContent).toContain('10:00')
    expect(document.querySelector('.time-slots')?.textContent).not.toContain('09:00')
    expect(document.querySelector('[data-submit]')).toBeNull()
    expect(document.getElementById('f-first-name')).toBeNull()

    document.querySelector('.time-slot')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.querySelector('[data-next]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(document.getElementById('f-first-name')?.value).toBe('P4')
    expect(document.getElementById('f-last-name')?.value).toBe('Loser')
    expect(document.getElementById('f-email')?.value).toBe('p4-conflict@example.test')
  })
})
