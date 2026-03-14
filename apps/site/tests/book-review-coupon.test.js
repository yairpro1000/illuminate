import { beforeEach, describe, expect, it } from 'vitest'
import couponCode from '../js/coupon.js?raw'
import bookViewsCode from '../js/book-views.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('book review coupon UI', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.localStorage.clear()
    evalCode(couponCode)
    evalCode(bookViewsCode)
  })

  it('renders coupon editing controls on the paid booking review step', () => {
    const views = window.BookPageViews.createBookPageViews({
      ctx: {
        source: '1_on_1',
        mode: 'new',
        slotType: 'session',
      },
      state: {
        step: 4,
        errors: {},
        selectedSlot: { start: '2026-03-17T10:00:00.000Z', end: '2026-03-17T11:00:00.000Z' },
        selectedSessionType: { title: 'Cycle Session' },
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        paymentMethod: 'pay-now',
        submitting: false,
        submissionError: null,
        publicConfig: { booking_policy_text: 'Booking policy\nRule 1\nRule 2\nRule 3' },
        couponCodeInput: 'ISRAEL',
        appliedCouponCode: 'ISRAEL',
        couponError: null,
        couponValidating: false,
        pricePreview: {
          baseChf: 120,
          finalChf: 90,
        },
      },
      siteConfig: {},
      helpers: {
        toYMD: () => '2026-03-17',
        formatTime: () => '10:00',
        formatDateLong: () => 'Tuesday, 17 March 2026',
        formatDateShort: () => 'Tue, 17 Mar',
        escHtml: (value) => String(value),
        buildBookingPolicyBlock: () => '<div>policy</div>',
        getNonPaidConfirmationWindowMinutes: () => 1,
        formatMinutesLabel: () => '1 minute',
      },
      isIntroFlow: () => false,
      isSessionPayNowFlow: () => true,
      slotWindowMonths: 4,
    })

    const html = views.buildShell().replace(/\s+/g, ' ')
    expect(html).toContain('Enter coupon code')
    expect(html).toContain('Applied: ISRAEL')
    expect(html).toContain('CHF 120')
    expect(html).toContain('CHF 90')
  })
})
