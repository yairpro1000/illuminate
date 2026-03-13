import { beforeEach, describe, expect, it } from 'vitest'
import confirmPageCode from '../js/pages/confirm.js?raw'
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

  it('confirm page treats PENDING as awaiting payment', async () => {
    document.body.innerHTML = '<div id="confirm-card"></div>'
    window.history.replaceState({}, '', '/confirm.html?token=tok-123')
    window.siteClient.requestJson = async () => ({
      source: 'session',
      status: 'PENDING',
      next_action_url: '/manage.html?token=tok-123',
      next_action_label: 'Manage booking',
    })

    evalCode(confirmPageCode)
    await flush()

    expect(document.getElementById('confirm-card').textContent).toContain('awaiting payment')
    expect(document.querySelector('#confirm-card a')?.getAttribute('href')).toBe('/manage.html?token=tok-123')
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
})
