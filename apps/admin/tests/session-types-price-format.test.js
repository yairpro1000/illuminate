import { beforeEach, describe, expect, it } from 'vitest'
import adminEditOffersHtml from '../session-types.html?raw'
import adminEditOffersCode from '../js/pages/session-types.js?raw'

function evalCode(code) { (0, eval)(code) }

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('admin edit offers price formatting', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = adminEditOffersHtml
    window.adminClient = {
      requestJson: async (path) => {
        if (path === '/admin/session-types') {
          return {
            session_types: [
              { id: 'st-1', title: 'First', price: 100, currency: 'CHF', duration_minutes: 60, status: 'active', sort_order: 1 },
              { id: 'st-2', title: 'Second', price: 100.99, currency: 'CHF', duration_minutes: 60, status: 'active', sort_order: 2 },
            ],
          }
        }
        if (path === '/admin/events/all') return { events: [] }
        throw new Error(`Unexpected path: ${path}`)
      },
      resolveUrl: (path) => path,
    }
    window.adminAuth = { handleUnauthorized: () => {} }
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  })

  it('renders integer amounts without trailing decimals and preserves real decimals', async () => {
    evalCode(adminEditOffersCode)
    await flush()

    const bodyText = document.getElementById('stBody').textContent.replace(/\s+/g, ' ')
    expect(bodyText).toContain('CHF 100')
    expect(bodyText).toContain('CHF 100.99')
    expect(bodyText).not.toContain('CHF 100.00')
  })
})
