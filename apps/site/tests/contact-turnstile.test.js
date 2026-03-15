import { beforeEach, describe, expect, it, vi } from 'vitest'
import contactCode from '../js/contact.js?raw'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('contact form turnstile submission', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="contact-form-wrap">
        <form id="contact-form">
          <input id="contact-first-name" name="first_name" />
          <span id="contact-first-name-error" hidden></span>
          <input id="contact-last-name" name="last_name" />
          <input id="contact-email" name="email" />
          <span id="contact-email-error" hidden></span>
          <select id="contact-topic" name="topic"><option value="">Select</option><option value="sessions">sessions</option></select>
          <textarea id="contact-message" name="message"></textarea>
          <span id="contact-message-error" hidden></span>
          <div id="contact-submit-error" hidden></div>
          <div id="contact-turnstile-wrap" hidden>
            <div id="contact-turnstile-host"></div>
            <p id="contact-turnstile-error" hidden></p>
          </div>
          <button id="contact-submit-btn" type="submit">Send</button>
        </form>
      </div>
      <div id="contact-success" hidden tabindex="-1"></div>
    `
    Element.prototype.scrollIntoView = vi.fn()
    HTMLElement.prototype.focus = vi.fn()
    window.siteClient = {
      config: {
        antibotMode: 'mock',
        turnstileEnabled: false,
        turnstileSiteKey: null,
        turnstileLoadError: null,
        turnstilePlaceholderToken: 'placeholder',
      },
    }
    window.siteObservability = {
      logMilestone: vi.fn(),
      logError: vi.fn(),
      startFlow: vi.fn(() => 'cid_contact'),
    }
    window.getPublicConfig = vi.fn().mockResolvedValue({
      antibot: {
        mode: 'turnstile',
        turnstile: {
          enabled: true,
          site_key: 'site-key-live',
        },
      },
    })
    window.SiteTurnstile = {
      applyPublicConfig: vi.fn((config, data) => {
        config.antibotMode = data.antibot.mode
        config.turnstileEnabled = data.antibot.turnstile.enabled
        config.turnstileSiteKey = data.antibot.turnstile.site_key
        config.turnstileLoadError = null
      }),
      markConfigLoadFailed: vi.fn(),
      renderVisibleWidget: vi.fn().mockResolvedValue(undefined),
      resolveToken: vi.fn().mockResolvedValue('contact-turnstile-token'),
      resetVisibleWidget: vi.fn(),
    }
    window._post = vi.fn().mockResolvedValue({ ok: true })
    evalCode(mockEmailPreviewCode)
  })

  it('loads turnstile config and submits the resolved token', async () => {
    evalCode(contactCode)
    await flush()

    document.getElementById('contact-first-name').value = 'Ada'
    document.getElementById('contact-last-name').value = 'Lovelace'
    document.getElementById('contact-email').value = 'ada@example.com'
    document.getElementById('contact-topic').value = 'sessions'
    document.getElementById('contact-message').value = 'Hello there'

    document.getElementById('contact-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    await flush()

    expect(window.SiteTurnstile.applyPublicConfig).toHaveBeenCalled()
    expect(window.SiteTurnstile.renderVisibleWidget).toHaveBeenCalledWith(expect.objectContaining({
      key: 'contact_form_submit',
    }))
    expect(window.SiteTurnstile.resolveToken).toHaveBeenCalledWith(expect.objectContaining({
      key: 'contact_form_submit',
      formName: 'contact_form',
      action: 'contact_form_submit',
    }))
    expect(window._post).toHaveBeenCalledWith('/api/contact', expect.objectContaining({
      first_name: 'Ada',
      email: 'ada@example.com',
      turnstile_token: 'contact-turnstile-token',
    }))
  })

  it('replaces the success body with the inline email preview when the backend returns mock_email_preview', async () => {
    window._post = vi.fn().mockResolvedValue({
      ok: true,
      mock_email_preview: {
        email_id: 'mock_msg_contact',
        to: 'ada@example.com',
        subject: 'New contact form message',
        html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_contact/html',
      },
    })

    evalCode(contactCode)
    await flush()

    document.getElementById('contact-first-name').value = 'Ada'
    document.getElementById('contact-email').value = 'ada@example.com'
    document.getElementById('contact-message').value = 'Hello there'

    document.getElementById('contact-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    await flush()

    expect(document.querySelector('.mock-email-preview__frame')?.getAttribute('src')).toBe(
      'https://api.letsilluminate.co/api/__dev/emails/mock_msg_contact/html',
    )
    expect(document.getElementById('contact-form-wrap').hidden).toBe(true)
  })
})
