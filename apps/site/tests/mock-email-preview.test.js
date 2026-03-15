import { beforeEach, describe, expect, it } from 'vitest'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('mock email preview helper', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>'
    evalCode(mockEmailPreviewCode)
  })

  it('renders the iframe, subject metadata, and raw-email link from the preview payload', () => {
    const rendered = window.SiteMockEmailPreview.render({
      container: document.getElementById('host'),
      preview: {
        email_id: 'mock_msg_1',
        to: 'preview@example.test',
        subject: 'Please confirm your booking',
        html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_1/html',
      },
      title: 'Booking received',
      message: 'Captured inline for test mode.',
      secondaryAction: {
        href: 'index.html',
        text: '← Back to homepage',
      },
    })

    expect(rendered).toBe(true)
    expect(document.querySelector('.mock-email-preview__title')?.textContent).toContain('Booking received')
    expect(document.querySelector('.mock-email-preview__meta')?.textContent).toContain('preview@example.test')
    expect(document.querySelector('.mock-email-preview__frame')?.getAttribute('src')).toBe(
      'https://api.letsilluminate.co/api/__dev/emails/mock_msg_1/html',
    )
    const links = Array.from(document.querySelectorAll('.mock-email-preview__actions a'))
    expect(links[0]?.getAttribute('href')).toBe('https://api.letsilluminate.co/api/__dev/emails/mock_msg_1/html')
    expect(links[1]?.getAttribute('href')).toBe('index.html')
  })
})
