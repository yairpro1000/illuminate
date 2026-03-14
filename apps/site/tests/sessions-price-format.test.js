import { beforeEach, describe, expect, it, vi } from 'vitest'
import couponCode from '../js/coupon.js?raw'
import sessionsCode from '../js/sessions.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('sessions price formatting', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sessionGrid"></div>'
    window.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    window.siteClient = {
      requestJson: vi.fn().mockResolvedValue({
        session_types: [
          {
            id: 'st-1',
            slug: 'first',
            title: 'First',
            short_description: 'Short',
            description: 'Long',
            duration_minutes: 60,
            price: 100,
            currency: 'CHF',
          },
          {
            id: 'st-2',
            slug: 'second',
            title: 'Second',
            short_description: 'Short',
            description: 'Long',
            duration_minutes: 60,
            price: 100.99,
            currency: 'CHF',
          },
        ],
      }),
    }
  })

  it('renders integer amounts without trailing decimals and keeps real decimals', async () => {
    evalCode(sessionsCode)
    await flush()

    const text = document.getElementById('sessionGrid').textContent
    expect(text).toContain('CHF 100')
    expect(text).toContain('CHF 100.99')
    expect(text).not.toContain('CHF 100.00')
  })

  it('rerenders session prices immediately when the Israel coupon is applied', async () => {
    evalCode(couponCode)
    evalCode(sessionsCode)
    await flush()

    expect(document.getElementById('sessionGrid').textContent).toContain('CHF 100')

    window.SiteCoupon.setAppliedCouponCode('ISRAEL', 'test')
    await flush()

    const text = document.getElementById('sessionGrid').textContent.replace(/\s+/g, ' ')
    expect(text).toContain('CHF 75')
    expect(text).toContain('400 ₪')
    expect(text).toContain('300 ₪')
  })
})
