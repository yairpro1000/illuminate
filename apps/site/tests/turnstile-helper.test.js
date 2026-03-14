import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import turnstileCode from '../js/turnstile.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('site turnstile helper', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.SiteTurnstile = undefined
    window.turnstile = undefined
  })

  afterEach(() => {
    delete window.turnstile
  })

  it('returns the placeholder token when turnstile is disabled', async () => {
    evalCode(turnstileCode)

    const token = await window.SiteTurnstile.resolveToken({
      config: {
        turnstileEnabled: false,
        turnstilePlaceholderToken: 'placeholder-token',
      },
    })

    expect(token).toBe('placeholder-token')
  })

  it('returns the stored token from the visible widget when turnstile is enabled', async () => {
    evalCode(turnstileCode)
    const host = document.createElement('div')
    document.body.appendChild(host)
    window.turnstile = {
      render: vi.fn((container, options) => {
        setTimeout(() => options.callback('resolved-turnstile-token'), 0)
        return 'widget-1'
      }),
      remove: vi.fn(),
      reset: vi.fn(),
    }

    await window.SiteTurnstile.renderVisibleWidget({
      key: 'booking_submit',
      container: host,
      config: {
        turnstileEnabled: true,
        turnstileSiteKey: 'site-key-live',
        turnstilePlaceholderToken: 'placeholder-token',
      },
      formName: 'booking',
      action: 'booking_submit',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const token = await window.SiteTurnstile.resolveToken({
      key: 'booking_submit',
      config: {
        turnstileEnabled: true,
        turnstileSiteKey: 'site-key-live',
        turnstilePlaceholderToken: 'placeholder-token',
      },
      formName: 'booking',
      action: 'booking_submit',
    })

    expect(token).toBe('resolved-turnstile-token')
    expect(window.turnstile.render).toHaveBeenCalled()
  })

  it('maps the real /api/config site_key field into frontend config', () => {
    evalCode(turnstileCode)

    const config = {
      turnstileEnabled: false,
      turnstileSiteKey: null,
      antibotMode: 'mock',
    }

    window.SiteTurnstile.applyPublicConfig(config, {
      antibot: {
        mode: 'turnstile',
        turnstile: {
          enabled: true,
          site_key: '0x4AAAA-real-key',
        },
      },
    })

    expect(config.antibotMode).toBe('turnstile')
    expect(config.turnstileEnabled).toBe(true)
    expect(config.turnstileSiteKey).toBe('0x4AAAA-real-key')
  })
})
