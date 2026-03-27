import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminAuthCode from '../js/admin-auth.js?raw'
import adminIndexHtml from '../index.html?raw'
import adminSessionTypesHtml from '../session-types.html?raw'
import adminConfigHtml from '../config.html?raw'
import adminContactMessagesHtml from '../contact-messages.html?raw'

function evalCode(code) { (0, eval)(code) }

describe('admin auth helpers', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = adminIndexHtml
    window.getAdminApiBase = () => 'https://api.letsilluminate.co/api'
    window.adminAuth = undefined
    window.ENV = undefined
  })

  it('builds Cloudflare Access login and logout URLs from the shared admin API base', () => {
    evalCode(adminAuthCode)

    expect(window.adminAuth.buildAccessLoginUrl()).toBe(
      'https://api.letsilluminate.co/cdn-cgi/access/login?returnTo=https%3A%2F%2Fapi.letsilluminate.co%2Fapi%2Fhealth',
    )
    expect(window.adminAuth.buildAccessLogoutUrl()).toBe(
      'https://api.letsilluminate.co/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fapi.letsilluminate.co%2Fcdn-cgi%2Faccess%2Flogin%3FreturnTo%3Dhttps%253A%252F%252Fapi.letsilluminate.co%252Fapi%252Fhealth',
    )
  })

  it('builds Cloudflare Access team-domain login and logout URLs when configured', () => {
    window.ENV = {
      VITE_CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'yairpro.cloudflareaccess.com',
    }
    Object.defineProperty(window, 'location', {
      value: new URL('https://admin.letsilluminate.co/index.html?tab=bookings#today'),
      configurable: true,
    })

    evalCode(adminAuthCode)

    expect(window.adminAuth.buildAccessLoginUrl()).toBe(
      'https://yairpro.cloudflareaccess.com/cdn-cgi/access/login/admin.letsilluminate.co?redirect_url=%2Findex.html%3Ftab%3Dbookings%23today',
    )
    expect(window.adminAuth.buildAccessLogoutUrl()).toBe(
      'https://yairpro.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fyairpro.cloudflareaccess.com%2Fcdn-cgi%2Faccess%2Flogin%2Fadmin.letsilluminate.co%3Fredirect_url%3D%252Findex.html%253Ftab%253Dbookings%2523today',
    )
  })

  it('injects a shared logout button into the admin header and routes it through relogin', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { assign },
      configurable: true,
    })

    evalCode(adminAuthCode)

    const button = document.getElementById('admin-logout-button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('Logout')
    expect(button?.className).toContain('theme-toggle')
    button.click()

    expect(assign).toHaveBeenCalledWith(
      'https://api.letsilluminate.co/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fapi.letsilluminate.co%2Fcdn-cgi%2Faccess%2Flogin%3FreturnTo%3Dhttps%253A%252F%252Fapi.letsilluminate.co%252Fapi%252Fhealth',
    )
  })

  it('keeps admin-auth loaded on all admin pages that receive the shared header action', () => {
    expect(adminIndexHtml).toContain('<script src="js/admin-auth.js"></script>')
    expect(adminSessionTypesHtml).toContain('<script src="js/admin-auth.js"></script>')
    expect(adminConfigHtml).toContain('<script src="js/admin-auth.js"></script>')
    expect(adminContactMessagesHtml).toContain('<script src="js/admin-auth.js"></script>')
  })

  it('renders the logout button markup on all admin pages', () => {
    expect(adminIndexHtml).toContain('id="admin-logout-button"')
    expect(adminSessionTypesHtml).toContain('id="admin-logout-button"')
    expect(adminConfigHtml).toContain('id="admin-logout-button"')
    expect(adminContactMessagesHtml).toContain('id="admin-logout-button"')
  })
})
