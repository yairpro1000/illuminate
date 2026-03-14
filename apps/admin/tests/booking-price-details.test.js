import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminBookingsHtml from '../index.html?raw'
import adminBookingsCode from '../js/pages/index.js?raw'

function evalCode(code) { (0, eval)(code) }

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('admin booking pricing details', () => {
  beforeEach(() => {
    window.open = vi.fn()
    navigator.clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  })

  it('renders booking snapshot price, currency, and coupon in the booking details modal', async () => {
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
                client_first_name: 'Yael',
                client_last_name: 'Cohen',
                client_email: 'yael@example.com',
                starts_at: '2026-03-18T09:00:00.000Z',
                ends_at: '2026-03-18T10:00:00.000Z',
                timezone: 'Asia/Jerusalem',
                current_status: 'CONFIRMED',
                session_type_title: 'Clarity Session',
                address_line: 'Tel Aviv',
                maps_url: 'https://maps.example.com/booking',
                booking_price: 112.5,
                booking_currency: 'CHF',
                booking_coupon_code: 'ISRAEL',
                payment_amount: 112.5,
                payment_currency: 'CHF',
                payment_status: 'PENDING',
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

    const row = document.querySelector('#rowsBody tr.clickable')
    row.click()
    await flush()

    const details = document.getElementById('editReadonlyDetails').textContent
    expect(details).toContain('Booked price')
    expect(details).toContain('112.5 CHF')
    expect(details).toContain('Coupon code')
    expect(details).toContain('ISRAEL')
    expect(details).toContain('Amount')
    expect(details).toContain('112.5 CHF')
  })
})
