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

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.getAttribute('src')).toBe(
      'https://api.letsilluminate.co/api/__dev/emails/mock_msg_admin/html',
    )
    expect(document.querySelector('.mock-email-preview__title')?.textContent).toContain('Booking received')
  })
})
