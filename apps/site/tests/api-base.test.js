import { describe, it, expect, beforeEach } from 'vitest'
import apiBaseCode from '../js/api-base.js?raw'

function evalCode(code) {
  // Evaluate in the browser-like global scope
  // eslint-disable-next-line no-eval
  (0, eval)(code)
}

describe('site api-base.js', () => {
  beforeEach(() => {
    // reset globals and storage
    window.API_BASE = undefined
    window.ENV = undefined
    window.__SITE_API_BASE_HOSTNAME__ = undefined
    // Use an in-memory localStorage mock to avoid jsdom quirks
    const mem = new Map()
    window.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)) },
      removeItem: (k) => { mem.delete(k) },
      clear: () => { mem.clear() },
    }
  })

  it('defaults to localhost:8788 when on localhost with no env/storage', () => {
    // jsdom hostname defaults to localhost
    evalCode(apiBaseCode)
    expect(window.API_BASE).toBe('http://localhost:8788')
  })

  it('uses env VITE_API_BASE when provided', () => {
    window.ENV = { VITE_API_BASE: 'https://api.letsilluminate.co/' }
    evalCode(apiBaseCode)
    expect(window.API_BASE).toBe('https://api.letsilluminate.co')
  })

  it('uses localStorage override when set (and strips trailing slashes)', () => {
    window.localStorage.setItem('API_BASE', 'http://devhost:9999///')
    evalCode(apiBaseCode)
    expect(window.API_BASE).toBe('http://devhost:9999')
  })

  it('defaults to the workers.dev root on pages.dev previews', () => {
    window.__SITE_API_BASE_HOSTNAME__ = 'preview-branch.pages.dev'
    evalCode(apiBaseCode)
    expect(window.API_BASE).toBe('https://illuminate.yairpro.workers.dev')
  })

  it('defaults to the workers.dev root on yairb.ch while letsilluminate is unhealthy', () => {
    window.__SITE_API_BASE_HOSTNAME__ = 'yairb.ch'
    evalCode(apiBaseCode)
    expect(window.API_BASE).toBe('https://illuminate.yairpro.workers.dev')
  })
})
