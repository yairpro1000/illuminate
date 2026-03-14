import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminBookingsHtml from '../index.html?raw'
import adminBookingsCode from '../js/pages/index.js?raw'
import adminContactMessagesHtml from '../contact-messages.html?raw'
import adminContactMessagesCode from '../js/pages/contact-messages.js?raw'

function evalCode(code) { (0, eval)(code) }

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('admin client dropdown dedup', () => {
  beforeEach(() => {
    window.open = vi.fn()
    navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  })

  it('deduplicates bookings clients by name plus email and sorts labels alphabetically', async () => {
    document.documentElement.innerHTML = adminBookingsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/events') return { events: [] }
        if (path.startsWith('/admin/bookings?')) {
          return {
            rows: [
              {
                booking_id: 'b1',
                client_id: 'c1',
                client_first_name: 'Pat',
                client_last_name: 'Race',
                client_email: 'pat@example.com',
                starts_at: '2026-03-16T09:00:00.000Z',
                current_status: 'CONFIRMED',
                session_type_title: 'Session',
              },
              {
                booking_id: 'b2',
                client_id: 'c2',
                client_first_name: 'Pat',
                client_last_name: 'Race',
                client_email: 'pat@example.com',
                starts_at: '2026-03-17T09:00:00.000Z',
                current_status: 'CONFIRMED',
                session_type_title: 'Session',
              },
              {
                booking_id: 'b3',
                client_id: 'c3',
                client_first_name: 'Alex',
                client_last_name: 'Mobile',
                client_email: 'alex@example.com',
                starts_at: '2026-03-18T09:00:00.000Z',
                current_status: 'PENDING',
                session_type_title: 'Session',
              },
            ],
          }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminBookingsCode)
    await flush()
    await flush()

    const sourceSelect = document.getElementById('source')
    sourceSelect.value = 'session'
    sourceSelect.dispatchEvent(new Event('change'))
    await flush()

    const clientSelect = document.getElementById('clientName')
    const labels = Array.from(clientSelect.options).map((option) => option.textContent)
    expect(labels).toEqual([
      'All clients',
      'Alex Mobile (alex@example.com)',
      'Pat Race (pat@example.com)',
    ])

    clientSelect.value = 'pat|race|pat@example.com'
    clientSelect.dispatchEvent(new Event('change'))

    const rows = Array.from(document.querySelectorAll('#rowsBody tr.clickable'))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.textContent.includes('Pat Race'))).toBe(true)
  })

  it('sorts bookings rows ascending and descending from clickable headers', async () => {
    document.documentElement.innerHTML = adminBookingsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/events') return { events: [] }
        if (path.startsWith('/admin/bookings?')) {
          return {
            rows: [
              {
                booking_id: 'b1',
                client_id: 'c1',
                client_first_name: 'Zoe',
                client_last_name: 'Zulu',
                client_email: 'zoe@example.com',
                starts_at: '2026-03-18T09:00:00.000Z',
                current_status: 'CONFIRMED',
                session_type_title: 'Gamma Session',
                notes: 'third',
              },
              {
                booking_id: 'b2',
                client_id: 'c2',
                client_first_name: 'Alex',
                client_last_name: 'Alpha',
                client_email: 'alex@example.com',
                starts_at: '2026-03-16T09:00:00.000Z',
                current_status: 'PENDING',
                session_type_title: 'Alpha Session',
                notes: 'first',
              },
              {
                booking_id: 'b3',
                client_id: 'c3',
                client_first_name: 'Mia',
                client_last_name: 'Middle',
                client_email: 'mia@example.com',
                starts_at: '2026-03-17T09:00:00.000Z',
                current_status: 'CANCELED',
                session_type_title: 'Beta Session',
                notes: 'second',
              },
            ],
          }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminBookingsCode)
    await flush()
    await flush()

    const typeSort = document.querySelector('[data-sort="title"]')
    typeSort.click()

    let rows = Array.from(document.querySelectorAll('#rowsBody tr.clickable'))
    expect(rows.map((row) => row.children[0].textContent)).toEqual([
      'Alpha Session',
      'Beta Session',
      'Gamma Session',
    ])

    typeSort.click()

    rows = Array.from(document.querySelectorAll('#rowsBody tr.clickable'))
    expect(rows.map((row) => row.children[0].textContent)).toEqual([
      'Gamma Session',
      'Beta Session',
      'Alpha Session',
    ])
  })

  it('deduplicates contact-message clients by name plus email and sorts labels alphabetically', async () => {
    document.documentElement.innerHTML = adminContactMessagesHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path.startsWith('/admin/contact-messages')) {
          return {
            rows: [
              {
                id: 'm1',
                client_id: 'c1',
                client_first_name: 'Pat',
                client_last_name: 'Race',
                client_email: 'pat@example.com',
                client_phone: '',
                created_at: '2026-03-14T10:00:00.000Z',
                message: 'First',
              },
              {
                id: 'm2',
                client_id: 'c2',
                client_first_name: 'Pat',
                client_last_name: 'Race',
                client_email: 'pat@example.com',
                client_phone: '',
                created_at: '2026-03-14T11:00:00.000Z',
                message: 'Second',
              },
              {
                id: 'm3',
                client_id: 'c3',
                client_first_name: 'Alex',
                client_last_name: 'Mobile',
                client_email: 'alex@example.com',
                client_phone: '',
                created_at: '2026-03-14T12:00:00.000Z',
                message: 'Third',
              },
            ],
          }
        }
        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    evalCode(adminContactMessagesCode)
    await flush()

    const clientSelect = document.getElementById('clientId')
    const labels = Array.from(clientSelect.options).map((option) => option.textContent)
    expect(labels).toEqual([
      'All clients',
      'Alex Mobile (alex@example.com)',
      'Pat Race (pat@example.com)',
    ])
  })
})
