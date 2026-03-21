import { beforeEach, describe, expect, it } from 'vitest'
import siteNavCode from '../js/site-nav.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

describe('site nav shared rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders privacy and terms links in the shared default footer', () => {
    document.body.innerHTML = '<footer class="footer" data-footer-variant="default" data-home-links="index"></footer>'

    evalCode(siteNavCode)

    const links = Array.from(document.querySelectorAll('.footer__links a')).map((link) => ({
      text: link.textContent?.trim(),
      href: link.getAttribute('href'),
      current: link.getAttribute('aria-current'),
    }))

    expect(links).toEqual(
      expect.arrayContaining([
        { text: 'Privacy Policy', href: 'privacy.html', current: null },
        { text: 'Terms of Service', href: 'terms.html', current: null },
      ]),
    )
  })

  it('marks the active legal footer link on the privacy page', () => {
    document.body.innerHTML = '<footer class="footer" data-footer-variant="default" data-home-links="index" data-current-page="privacy"></footer>'

    evalCode(siteNavCode)

    const privacyLink = document.querySelector('.footer__links a[href="privacy.html"]')
    const termsLink = document.querySelector('.footer__links a[href="terms.html"]')

    expect(privacyLink?.getAttribute('aria-current')).toBe('page')
    expect(termsLink?.getAttribute('aria-current')).toBeNull()
  })
})
