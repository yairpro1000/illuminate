import { beforeEach, describe, expect, it } from 'vitest'
import adminEditOffersHtml from '../session-types.html?raw'
import adminEditOffersCode from '../js/pages/session-types.js?raw'

function evalCode(code) { (0, eval)(code) }

function optionValues(selectId) {
  return Array.from(document.getElementById(selectId).options).map((option) => option.value)
}

describe('admin edit offers status options', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = adminEditOffersHtml
    window.adminClient = {
      requestJson: async (path) => {
        if (path === '/admin/session-types') return { session_types: [] }
        if (path === '/admin/events/all') return { events: [] }
        throw new Error(`Unexpected path: ${path}`)
      },
      resolveUrl: (path) => path,
    }
    window.adminAuth = { handleUnauthorized: () => {} }
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    evalCode(adminEditOffersCode)
  })

  it('renders only schema-aligned session type and event status values', () => {
    expect(optionValues('stFStatus')).toEqual(['draft', 'active', 'hidden'])
    expect(optionValues('evFStatus')).toEqual(['draft', 'published', 'cancelled', 'sold_out'])
  })
})
