import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminClientsHtml from '../clients.html?raw'
import adminClientsCode from '../js/pages/clients.js?raw'

function evalCode(code) { (0, eval)(code) }
function flush() { return new Promise((resolve) => setTimeout(resolve, 0)) }

describe('admin clients page', () => {
  beforeEach(() => {
    const assign = vi.fn()
    window.open = vi.fn()
    delete window.location
    window.location = { assign, search: '', pathname: '/admin/clients.html' }
  })

  it('filters rows with sessions/events pills client-side', async () => {
    document.documentElement.innerHTML = adminClientsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/clients') {
          return {
            rows: [
              { id: 'c1', first_name: 'Maya', last_name: 'Doe', email: 'maya@example.com', phone: '', sessions_count: 1, last_session_at: '2026-03-20T10:00:00.000Z', events_count: 0, last_event_at: null },
              { id: 'c2', first_name: 'Lea', last_name: 'Ray', email: 'lea@example.com', phone: '', sessions_count: 0, last_session_at: null, events_count: 1, last_event_at: '2026-03-21T10:00:00.000Z' },
              { id: 'c3', first_name: 'Noa', last_name: 'Both', email: 'noa@example.com', phone: '', sessions_count: 2, last_session_at: '2026-03-22T10:00:00.000Z', events_count: 3, last_event_at: '2026-03-23T10:00:00.000Z' },
            ],
          }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminClientsCode)
    await flush()

    expect(document.querySelectorAll('#rowsBody tr.clickable')).toHaveLength(3)

    document.getElementById('sessionsToggle').click()
    await flush()
    expect(document.querySelectorAll('#rowsBody tr.clickable')).toHaveLength(2)

    document.getElementById('eventsToggle').click()
    await flush()
    expect(document.querySelectorAll('#rowsBody tr.clickable')).toHaveLength(1)
    expect(document.querySelector('#rowsBody tr.clickable').textContent).toContain('Noa Both')
  })

  it('sorts rows from clickable headers', async () => {
    document.documentElement.innerHTML = adminClientsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/clients') {
          return {
            rows: [
              { id: 'c1', first_name: 'Zoe', last_name: 'Zulu', email: 'zoe@example.com', phone: '', sessions_count: 1, last_session_at: '2026-03-20T10:00:00.000Z', events_count: 0, last_event_at: null },
              { id: 'c2', first_name: 'Alex', last_name: 'Alpha', email: 'alex@example.com', phone: '', sessions_count: 3, last_session_at: '2026-03-25T10:00:00.000Z', events_count: 1, last_event_at: '2026-03-24T10:00:00.000Z' },
              { id: 'c3', first_name: 'Mia', last_name: 'Middle', email: 'mia@example.com', phone: '', sessions_count: 2, last_session_at: '2026-03-22T10:00:00.000Z', events_count: 2, last_event_at: '2026-03-23T10:00:00.000Z' },
            ],
          }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminClientsCode)
    await flush()

    const sessionsSort = document.querySelector('[data-sort="sessions_count"]')
    sessionsSort.click()
    await flush()
    expect(Array.from(document.querySelectorAll('#rowsBody tr.clickable')).map((row) => row.children[0].textContent)).toEqual([
      'Alex Alpha',
      'Mia Middle',
      'Zoe Zulu',
    ])

    sessionsSort.click()
    await flush()
    expect(Array.from(document.querySelectorAll('#rowsBody tr.clickable')).map((row) => row.children[0].textContent)).toEqual([
      'Zoe Zulu',
      'Mia Middle',
      'Alex Alpha',
    ])
  })

  it('redirects booking-for-client through rebook with admin token and prefill params', async () => {
    document.documentElement.innerHTML = adminClientsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/clients') {
          return { rows: [{ id: 'c1', first_name: 'Maya', last_name: 'Doe', email: 'maya@example.com', phone: '+41 1', sessions_count: 1, last_session_at: null, events_count: 0, last_event_at: null }] }
        }
        if (path === '/admin/clients/c1/booking-token') {
          return { token: 'am1.c1.token', site_url: 'https://letsilluminate.co' }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminClientsCode)
    await flush()

    document.querySelector('#rowsBody tr.clickable').click()
    await flush()
    document.getElementById('bookSession').click()
    await flush()

    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/rebook.html?'), '_blank', 'noopener,noreferrer')
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('source=session'), '_blank', 'noopener,noreferrer')
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('admin_token=am1.c1.token'), '_blank', 'noopener,noreferrer')
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('prefill_email=maya%40example.com'), '_blank', 'noopener,noreferrer')
  })
})
