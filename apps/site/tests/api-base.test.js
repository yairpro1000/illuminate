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
})
