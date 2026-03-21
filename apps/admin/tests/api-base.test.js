import { describe, it, expect, beforeEach } from 'vitest'
import adminApiBaseCode from '../js/api-base.js?raw'

function evalCode(code) { (0, eval)(code) }

describe('admin api-base.js', () => {
  beforeEach(() => {
    const mem = new Map()
    window.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)) },
      removeItem: (k) => { mem.delete(k) },
      clear: () => { mem.clear() },
    }
    window.__ADMIN_API_BASE_HOSTNAME__ = 'localhost'
    window.__ADMIN_API_BASE_SEARCH__ = ''
    window.ENV = undefined
    window.__setAdminApiBaseFromQuery = undefined
    // Reset stored functions
    window.getAdminApiBase = undefined
    window.resolveAdminUrl = undefined
  })

  it('defaults to http://localhost:8788/api for localhost', () => {
    evalCode(adminApiBaseCode)
    expect(window.getAdminApiBase()).toBe('http://localhost:8788/api')
    expect(window.resolveAdminUrl('/admin/events')).toBe('http://localhost:8788/api/admin/events')
  })

  it('uses env VITE_API_BASE + /api when provided', () => {
    window.ENV = { VITE_API_BASE: 'https://api.letsilluminate.co/' }
    evalCode(adminApiBaseCode)
    expect(window.getAdminApiBase()).toBe('https://api.letsilluminate.co/api')
  })

  it('uses localStorage override when set (full base)', () => {
    window.localStorage.setItem('admin_api_base', 'https://api.example.com/api///')
    evalCode(adminApiBaseCode)
    expect(window.getAdminApiBase()).toBe('https://api.example.com/api')
    expect(window.resolveAdminUrl('admin/config')).toBe('https://api.example.com/api/admin/config')
  })

  it('ignores and clears stale override on non-localhost domains', () => {
    window.localStorage.setItem('admin_api_base', 'https://bad.example.com/api')
    window.__ADMIN_API_BASE_HOSTNAME__ = 'admin.letsilluminate.co'
    evalCode(adminApiBaseCode)
    expect(window.getAdminApiBase()).toBe('https://api.letsilluminate.co/api')
    expect(window.localStorage.getItem('admin_api_base')).toBe(null)
  })

  it('defaults to the workers.dev api on pages.dev previews', () => {
    window.__ADMIN_API_BASE_HOSTNAME__ = 'admin-preview.pages.dev'
    evalCode(adminApiBaseCode)
    expect(window.getAdminApiBase()).toBe('https://illuminate.yairpro.workers.dev/api')
  })
})
