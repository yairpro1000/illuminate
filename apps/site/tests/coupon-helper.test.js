import { beforeEach, describe, expect, it } from 'vitest'
import couponCode from '../js/coupon.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('site coupon helper', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-coupon-price data-price-chf="150" data-price-currency="CHF"></div>
    `
    window.localStorage.clear()
  })

  it('persists the Israel coupon and rewrites static price displays with discount markup', () => {
    evalCode(couponCode)

    expect(window.SiteCoupon.setAppliedCouponCode('ISRAEL', 'test')).toBe(true)
    window.SiteCoupon.applyStaticPrices(document)

    expect(window.localStorage.getItem('couponCode')).toBe('ISRAEL')
    const text = document.querySelector('[data-coupon-price]').textContent.replace(/\s+/g, ' ')
    expect(text).toContain('CHF 150')
    expect(text).toContain('CHF 112.50')
    expect(text).toContain('600 ₪')
    expect(text).toContain('450 ₪')
  })

  it('formats thousands with comma separators for coupon-aware pricing', () => {
    document.body.innerHTML = `
      <div data-coupon-price data-price-chf="990" data-price-currency="CHF"></div>
    `
    evalCode(couponCode)

    expect(window.SiteCoupon.setAppliedCouponCode('ISRAEL', 'test')).toBe(true)
    window.SiteCoupon.applyStaticPrices(document)

    const text = document.querySelector('[data-coupon-price]').textContent.replace(/\s+/g, ' ')
    expect(text).toContain('CHF 990')
    expect(text).toContain('CHF 742.50')
    expect(text).toContain('3,960 ₪')
    expect(text).toContain('2,970 ₪')
  })
})
