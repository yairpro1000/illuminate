import { beforeEach, describe, expect, it } from 'vitest'
import bookViewsCode from '../js/book-views.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('book pay-later confirmation UI', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.siteClient = {
      resolveHomepageHref: () => new URL('/index.html', window.location.origin).toString(),
    }
    evalCode(bookViewsCode)
  })

  it('renders only the homepage action after pay-later submit', () => {
    const views = window.BookPageViews.createBookPageViews({
      ctx: {
        source: '1_on_1',
        mode: 'new',
        slotType: 'session',
      },
      state: {
        step: 5,
        errors: {},
        selectedSlot: { start: '2026-03-17T10:00:00.000Z', end: '2026-03-17T11:00:00.000Z' },
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        paymentMethod: 'pay-later',
        submissionStatus: 'PENDING',
        submissionContinuePaymentUrl: '/continue-payment.html?token=m1.test',
        submissionManageUrl: '/manage.html?token=m1.test',
        submitting: false,
        submissionError: null,
        publicConfig: { booking_policy_text: 'Booking policy\nRule 1\nRule 2\nRule 3' },
      },
      siteConfig: {},
      helpers: {
        toYMD: () => '2026-03-17',
        formatTime: () => '10:00',
        formatDateLong: () => 'Tuesday, 17 March 2026',
        formatDateShort: () => 'Tue, 17 Mar',
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
    expect(html).toContain('Booking received!')
    expect(html).toContain('Please confirm your booking there first')
    expect(html).not.toContain('Complete payment')
    expect(html).not.toContain('/continue-payment.html?token=m1.test')
    expect(html).toContain('← Back to homepage')
    expect(html).toContain(`href="${window.location.origin}/index.html"`)
  })

  it('renders the hold-window note on the pay-later review step before confirmation', () => {
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
        paymentMethod: 'pay-later',
        submitting: false,
        submissionError: null,
        publicConfig: { booking_policy_text: 'Booking policy\nRule 1\nRule 2\nRule 3' },
      },
      siteConfig: {},
      helpers: {
        toYMD: () => '2026-03-17',
        formatTime: () => '10:00',
        formatDateLong: () => 'Tuesday, 17 March 2026',
        formatDateShort: () => 'Tue, 17 Mar',
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
    expect(html).toContain('Your slot is kindly held for the next 15 minutes before expiring.')
    expect(html).toContain('Confirm Booking')
  })

  it('keeps the standard confirmation copy even when preview metadata is present because rendering moved to the shared client layer', () => {
    const views = window.BookPageViews.createBookPageViews({
      ctx: {
        source: '1_on_1',
        mode: 'new',
        slotType: 'session',
      },
      state: {
        step: 5,
        errors: {},
        selectedSlot: { start: '2026-03-17T10:00:00.000Z', end: '2026-03-17T11:00:00.000Z' },
        firstName: 'Yair',
        lastName: 'Test',
        email: 'yair@example.com',
        phone: '+41000000001',
        paymentMethod: 'pay-later',
        submissionStatus: 'PENDING',
        submissionContinuePaymentUrl: '/continue-payment.html?token=m1.test',
        submissionManageUrl: '/manage.html?token=m1.test',
        mockEmailPreview: {
          email_id: 'mock_msg_123',
          to: 'yair@example.com',
          subject: 'Please confirm your booking',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_123/html',
        },
        submitting: false,
        submissionError: null,
        publicConfig: { booking_policy_text: 'Booking policy\nRule 1\nRule 2\nRule 3' },
      },
      siteConfig: {},
      helpers: {
        toYMD: () => '2026-03-17',
        formatTime: () => '10:00',
        formatDateLong: () => 'Tuesday, 17 March 2026',
        formatDateShort: () => 'Tue, 17 Mar',
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
    expect(html).toContain('Please confirm your booking there first')
    expect(html).not.toContain('data-mock-email-preview-host')
  })
})
