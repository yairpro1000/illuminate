import { beforeEach, describe, expect, it, vi } from 'vitest'
import clientCode from '../js/client.js?raw'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('site client mock email preview integration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.API_BASE = 'https://api.letsilluminate.co'
    window.getSiteApiBase = () => 'https://api.letsilluminate.co'
    window.siteObservability = {
      getCorrelationId: () => 'cid_site_test',
      startFlow: () => 'cid_site_test',
      logError: vi.fn(),
      logInfo: vi.fn(),
      logMilestone: vi.fn(),
    }
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    })

    global.fetch = vi.fn(async (_url, init = {}) => {
      expect(init.headers.get('x-illuminate-ui-test-mode')).toBe('playwright')
      return new Response(JSON.stringify({
        ok: true,
        mock_email_preview: {
          email_id: 'mock_msg_site',
          to: 'site@example.test',
          subject: 'Booking received',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_site/html',
          html_content: '<html><body><a href="https://letsilluminate.co/confirm.html?token=abc">Confirm booking</a></body></html>',
          email_kind: 'booking_confirm_request',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    evalCode(mockEmailPreviewCode)
    evalCode(clientCode)
  })

  it('sends the ui-test header and renders the preview overlay from the shared site request client', async () => {
    await window.siteClient.requestJson('/api/example')

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('Confirm booking')
    expect(document.querySelector('.mock-email-preview__title')?.textContent).toContain('Booking received')
  })
})
