import { beforeEach, describe, expect, it } from 'vitest'
import confirmPageCode from '../js/pages/confirm.js?raw'
import devPayPageCode from '../js/pages/dev-pay.js?raw'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'
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
      detectUiTestMode: () => 'playwright',
      maybeRenderMockEmailPreview: async (data) => {
        if (data && data.mock_email_preview) {
          window.IlluminateMockEmailPreview.render({ preview: data.mock_email_preview })
        }
      },
    }
    window.buildAtcWidget = (event) => `<div class="atc-widget" data-atc-title="${event.title}">Add to calendar</div>`
    window.initAddToCalendar = () => {}
    window.history.replaceState({}, '', '/')
    evalCode(mockEmailPreviewCode)
  })

  it('confirm page treats confirmed complete-payment action as awaiting payment', async () => {
    document.body.innerHTML = '<div id="confirm-card"></div>'
    window.history.replaceState({}, '', '/confirm.html?token=tok-123')
    window.siteClient.requestJson = async () => ({
      source: 'session',
      status: 'CONFIRMED',
      next_action_url: '/continue-payment.html?token=tok-123',
      next_action_label: 'Complete Payment',
      calendar_event: {
        title: 'Clarity Session — ILLUMINATE by Yair Benharroch',
        start: '2026-03-20T10:00:00.000Z',
        end: '2026-03-20T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        location: 'Lugano',
        description: '1:1 Clarity Session with Yair Benharroch.',
      },
      calendar_sync_pending_retry: true,
    })

    evalCode(confirmPageCode)
    await flush()

    expect(document.getElementById('confirm-card').textContent).toContain('awaiting payment')
    expect(document.querySelector('#confirm-card .atc-widget')?.getAttribute('data-atc-title')).toBe('Clarity Session — ILLUMINATE by Yair Benharroch')
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
      calendar_event: {
        title: 'Clarity Session — ILLUMINATE by Yair Benharroch',
        start: '2026-03-20T10:00:00.000Z',
        end: '2026-03-20T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        location: 'Lugano',
        description: '1:1 Clarity Session with Yair Benharroch.',
      },
      calendar_sync_pending_retry: false,
    })

    evalCode(paymentSuccessPageCode)
    await flush()

    expect(document.querySelector('.result-title')?.textContent).toContain('Payment confirmed')
    expect(document.querySelector('.result-card a')?.getAttribute('href')).toBe('/manage.html?token=tok-123')
    expect(document.querySelector('.result-card .atc-widget')?.getAttribute('data-atc-title')).toBe('Clarity Session — ILLUMINATE by Yair Benharroch')
  })

  it('confirm page renders the captured email iframe when mock preview metadata is present', async () => {
    document.body.innerHTML = '<div id="confirm-card"></div>'
    window.history.replaceState({}, '', '/confirm.html?token=tok-456')
    window.siteClient.requestJson = async () => {
      const response = {
        source: 'session',
        status: 'CONFIRMED',
        next_action_url: '/manage.html?token=tok-456',
        next_action_label: 'Manage booking',
        mock_email_preview: {
          email_id: 'mock_msg_confirm',
          to: 'maya@example.test',
          subject: 'Booking confirmed',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_confirm/html',
          html_content: '<html><body><a href="/manage.html?token=tok-456">Manage booking</a></body></html>',
        },
      }
      await window.siteClient.maybeRenderMockEmailPreview(response)
      return response
    }

    evalCode(confirmPageCode)
    await flush()

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('Manage booking')
  })

  it('payment success page renders the captured email iframe when mock preview metadata is present', async () => {
    document.body.innerHTML = '<div class="result-card"></div>'
    window.history.replaceState({}, '', '/payment-success.html?session_id=sess-preview')
    window.siteClient.requestJson = async () => {
      const response = {
        status: 'CONFIRMED',
        manage_url: '/manage.html?token=tok-preview',
        next_action_url: '/manage.html?token=tok-preview',
        next_action_label: 'Manage booking',
        mock_email_preview: {
          email_id: 'mock_msg_payment',
          to: 'maya@example.test',
          subject: 'Payment confirmed',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_payment/html',
          html_content: '<html><body><a href="/manage.html?token=tok-preview">Manage booking</a></body></html>',
        },
      }
      await window.siteClient.maybeRenderMockEmailPreview(response)
      return response
    }

    evalCode(paymentSuccessPageCode)
    await flush()

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('Manage booking')
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
      search: '?session_id=sess-123&amount=83&currency=chf',
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

    expect(document.getElementById('dev-detail')?.textContent).toContain('CHF 83.00')
    expect(navigatedTo).toBe('payment-success?session_id=sess-123')

    window.location = originalLocation
  })
})
