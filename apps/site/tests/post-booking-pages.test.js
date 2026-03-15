import { beforeEach, describe, expect, it } from 'vitest'
import confirmPageCode from '../js/pages/confirm.js?raw'
import devPayPageCode from '../js/pages/dev-pay.js?raw'
import paymentSuccessPageCode from '../js/pages/payment-success.js?raw'

function evalCode(code) {
  // Evaluate in the browser-like global scope
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('post-booking pages', () => {
  beforeEach(() => {
    window.siteClient = {
      requestJson: async () => ({}),
    }
    window.history.replaceState({}, '', '/')
  })

  it('confirm page treats confirmed complete-payment action as awaiting payment', async () => {
    document.body.innerHTML = '<div id="confirm-card"></div>'
    window.history.replaceState({}, '', '/confirm.html?token=tok-123')
    window.siteClient.requestJson = async () => ({
      source: 'session',
      status: 'CONFIRMED',
      next_action_url: '/continue-payment.html?token=tok-123',
      next_action_label: 'Complete Payment',
    })

    evalCode(confirmPageCode)
    await flush()

    expect(document.getElementById('confirm-card').textContent).toContain('awaiting payment')
    const links = Array.from(document.querySelectorAll('#confirm-card a'))
    expect(links[0]?.getAttribute('href')).toBe('/continue-payment.html?token=tok-123')
    expect(links[1]?.getAttribute('href')).toBe('index.html')
  })

  it('payment success page treats uppercase CONFIRMED as confirmed', async () => {
    document.body.innerHTML = '<div class="result-card"></div>'
    window.history.replaceState({}, '', '/payment-success.html?session_id=sess-123')
    window.siteClient.requestJson = async () => ({
      status: 'CONFIRMED',
      manage_url: '/manage.html?token=tok-123',
    })

    evalCode(paymentSuccessPageCode)
    await flush()

    expect(document.querySelector('.result-title')?.textContent).toContain('Payment confirmed')
    expect(document.querySelector('.result-card a')?.getAttribute('href')).toBe('/manage.html?token=tok-123')
  })

  it('dev pay success redirects to payment-success after mock settlement', async () => {
    document.body.innerHTML = `
      <p id="dev-detail"></p>
      <button id="btn-success">✓ Simulate payment success</button>
      <button id="btn-fail">✗ Simulate payment failure</button>
    `
    let navigatedTo = null
    const originalLocation = window.location
    delete window.location
    window.location = {
      search: '?session_id=sess-123&amount=150&currency=chf',
      get href() {
        return navigatedTo
      },
      set href(value) {
        navigatedTo = value
      },
    }

    window.siteClient.requestJson = async () => ({ ok: true })

    evalCode(devPayPageCode)
    document.getElementById('btn-success')?.click()
    await flush()

    expect(document.getElementById('dev-detail')?.textContent).toContain('CHF 1.50')
    expect(navigatedTo).toBe('payment-success?session_id=sess-123')

    window.location = originalLocation
  })
})
