import { beforeEach, describe, expect, it } from 'vitest'
import bookViewsCode from '../js/book-views.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('book event review UI', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    evalCode(bookViewsCode)
  })

  it('renders the hold-window note before the free event confirmation button', () => {
    const views = window.BookPageViews.createBookPageViews({
      ctx: {
        source: 'evening',
        mode: 'new',
        isPaid: false,
        eventTitle: 'ILLUMINATE Evening',
        eventDisplay: 'Thursday, 19 March 2026 · 19:00',
      },
      state: {
        step: 2,
        errors: {},
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        publicConfig: { booking_policy_text: 'Booking policy\nRule 1' },
      },
      siteConfig: {},
      helpers: {
        toYMD: () => '2026-03-19',
        formatTime: () => '19:00',
        formatDateLong: () => 'Thursday, 19 March 2026',
        formatDateShort: () => 'Thu, 19 Mar',
        escHtml: (value) => String(value),
        buildBookingPolicyBlock: () => '<div>policy</div>',
        getNonPaidConfirmationWindowMinutes: () => 15,
        formatMinutesLabel: () => '15 minutes',
      },
      isIntroFlow: () => false,
      isSessionPayNowFlow: () => false,
      isZeroPriceFlow: () => false,
      slotWindowMonths: 4,
    })

    const html = views.buildShell().replace(/\s+/g, ' ')
    expect(html).toContain('Your spot is kindly held for the next 15 minutes before expiring.')
    expect(html).toContain('Complete Registration')
  })
})
