import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import couponCode from '../js/coupon.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('site coupon helper', () => {
  let fetchMock

  beforeEach(() => {
    document.body.innerHTML = `
      <div data-coupon-price data-price-chf="150" data-price-currency="CHF"></div>
    `
    window.localStorage.clear()
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        visitor: {
          country: null,
        },
      }),
    })
    window.fetch = fetchMock
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('re-checks request country on refresh before showing the Israel banner', async () => {
    document.body.setAttribute('data-page', 'sessions')
    document.body.innerHTML = `
      <section id="session-types">
        <div class="container"></div>
      </section>
    `
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        visitor: {
          country: 'CH',
        },
      }),
    })
    evalCode(couponCode)

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await window.SiteCoupon.resolveVisitorCountry()

    expect(document.querySelector('[data-coupon-suggestion]')).toBeNull()
  })

  it('shows the Israel banner after refresh when request country resolves to IL', async () => {
    document.body.setAttribute('data-page', 'sessions')
    document.body.innerHTML = `
      <section id="session-types">
        <div class="container"></div>
      </section>
    `
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        visitor: {
          country: 'IL',
        },
      }),
    })
    evalCode(couponCode)

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await window.SiteCoupon.resolveVisitorCountry()

    const banner = document.querySelector('[data-coupon-suggestion]')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('Apply Israel discount')
  })

  it('logs the resolved request country on the homepage', async () => {
    document.body.setAttribute('data-page', 'home')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        visitor: {
          country: 'IL',
        },
      }),
    })
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    evalCode(couponCode)

    document.dispatchEvent(new Event('DOMContentLoaded'))
    await window.SiteCoupon.resolveVisitorCountry()

    expect(consoleLogSpy).toHaveBeenCalledWith('[coupon] request.cf.country via /api/config:', 'IL')
  })
})
