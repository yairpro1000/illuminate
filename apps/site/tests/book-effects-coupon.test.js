import { beforeEach, describe, expect, it, vi } from 'vitest'
import bookEffectsCode from '../js/book-effects.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('book effects coupon submission', () => {
  beforeEach(() => {
    window.bookingPayNow = vi.fn().mockResolvedValue({ booking_id: 'bk-1', checkout_url: 'https://checkout.local' })
    window.bookingPayLater = vi.fn().mockResolvedValue({ booking_id: 'bk-2', status: 'PENDING' })
    window.bookingReschedule = vi.fn()
    window.eventBook = vi.fn()
    window.eventBookWithAccess = vi.fn()
    window._get = vi.fn()
    window.getPublicConfig = vi.fn()
    window.SiteTurnstile = {
      resolveToken: vi.fn().mockResolvedValue('turnstile-live-token'),
    }
  })

  it('forwards offer slug and coupon code on paid session booking submissions', async () => {
    evalCode(bookEffectsCode)

    await window.BookPageEffects.submitBooking({
      state: {
        selectedSlot: {
          start: '2026-03-17T10:00:00.000Z',
          end: '2026-03-17T11:00:00.000Z',
        },
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        paymentMethod: 'pay-now',
        appliedCouponCode: 'ISRAEL',
        pricePreview: { baseChf: 120 },
      },
      context: {
        slotType: 'session',
        offerSlug: 'cycle-session',
        adminToken: 'am1.mock',
      },
      config: {
        timezone: 'Europe/Zurich',
        turnstilePlaceholderToken: 'placeholder',
      },
      observability: null,
      isIntroFlow: () => false,
    })

    expect(window.bookingPayNow).toHaveBeenCalledWith(expect.objectContaining({
      offer_slug: 'cycle-session',
      coupon_code: 'ISRAEL',
      type: 'session',
      turnstile_token: 'turnstile-live-token',
      admin_token: 'am1.mock',
    }))
  })

  it('routes zero-price coupon booking submissions through the non-paid path', async () => {
    evalCode(bookEffectsCode)

    await window.BookPageEffects.submitBooking({
      state: {
        selectedSlot: {
          start: '2026-03-17T10:00:00.000Z',
          end: '2026-03-17T11:00:00.000Z',
        },
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        paymentMethod: 'pay-now',
        appliedCouponCode: 'FREE100',
        pricePreview: { baseChf: 120, finalChf: 0 },
      },
      context: {
        slotType: 'session',
        offerSlug: 'cycle-session',
      },
      config: {
        timezone: 'Europe/Zurich',
        turnstilePlaceholderToken: 'placeholder',
      },
      observability: null,
      isIntroFlow: () => false,
    })

    expect(window.bookingPayLater).toHaveBeenCalledWith(expect.objectContaining({
      coupon_code: 'FREE100',
      type: 'session',
    }))
    expect(window.bookingPayNow).not.toHaveBeenCalled()
  })
})
