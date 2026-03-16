import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminClientCode from '../js/client.js?raw'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('admin client mock email preview integration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.resolveAdminUrl = (path) => `https://api.letsilluminate.co/api${path}`
    window.adminObservability = {
      getCorrelationId: () => 'cid_admin_test',
      startFlow: () => 'cid_admin_test',
      logError: vi.fn(),
      logInfo: vi.fn(),
      logMilestone: vi.fn(),
    }
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    })

    global.fetch = vi.fn(async (url, init = {}) => {
      if (String(url).includes('/observability/frontend')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      expect(init.headers.get('x-illuminate-ui-test-mode')).toBe('playwright')
      return new Response(JSON.stringify({
        ok: true,
        mock_email_preview: {
          email_id: 'mock_msg_admin',
          to: 'admin@example.test',
          subject: 'Booking received',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_admin/html',
          html_content: '<html><body><a href="https://letsilluminate.co/confirm.html?token=abc">Confirm booking</a></body></html>',
          email_kind: 'booking_confirm_request',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    evalCode(mockEmailPreviewCode)
    evalCode(adminClientCode)
  })

  it('sends the ui-test header and renders the preview overlay from shared admin requestJson', async () => {
    await window.adminClient.requestJson('/admin/example')

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('Confirm booking')
    expect(document.querySelector('.mock-email-preview__title')?.textContent).toContain('Booking received')
  })

  it('renders the preview overlay without ui-test mode when the API returns mock_email_preview', async () => {
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: false,
    })
    global.fetch = vi.fn(async (url, init = {}) => {
      if (String(url).includes('/observability/frontend')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      expect(init.headers.has('x-illuminate-ui-test-mode')).toBe(false)
      return new Response(JSON.stringify({
        ok: true,
        mock_email_preview: {
          email_id: 'mock_msg_admin_manual',
          to: 'admin@example.test',
          subject: 'Booking received',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_admin_manual/html',
          html_content: '<html><body>manual admin preview</body></html>',
          email_kind: 'booking_confirm_request',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await window.adminClient.requestJson('/admin/example')

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('manual admin preview')
    expect(document.querySelector('.mock-email-preview__message')?.textContent).toContain('Mock email mode is active')
  })
})
