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

  it('renders refund document links only when the stored Stripe URLs exist', async () => {
    document.documentElement.innerHTML = adminBookingsHtml
    window.adminClient = {
      requestJson: vi.fn(async (path) => {
        if (path === '/admin/events') return { events: [] }
        if (path.startsWith('/admin/bookings?')) {
          return {
            rows: [
              {
                booking_id: 'b2',
                client_id: 'c2',
                client_first_name: 'Lea',
                client_last_name: 'Meyer',
                client_email: 'lea@example.com',
                starts_at: '2026-03-18T09:00:00.000Z',
                ends_at: '2026-03-18T10:00:00.000Z',
                timezone: 'Europe/Zurich',
                current_status: 'CANCELED',
                session_type_title: 'Clarity Session',
                address_line: 'Lugano',
                maps_url: 'https://maps.example.com/booking',
                booking_price: 150,
                booking_currency: 'CHF',
                payment_amount: 150,
                payment_currency: 'CHF',
                payment_status: 'REFUNDED',
                payment_refund_status: 'SUCCEEDED',
                payment_refund_amount: 150,
                payment_refund_currency: 'CHF',
                payment_stripe_refund_id: 're_123',
                payment_stripe_credit_note_id: 'cn_123',
                payment_stripe_receipt_url: 'https://stripe.example/receipt/ch_123',
                payment_stripe_credit_note_url: 'https://stripe.example/credit-note/cn_123.pdf',
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

    const modalHtml = document.getElementById('editReadonlyDetails').innerHTML
    expect(modalHtml).toContain('Refund status')
    expect(modalHtml).toContain('SUCCEEDED')
    expect(modalHtml).toContain('Stripe refund')
    expect(modalHtml).toContain('re_123')
    expect(modalHtml).toContain('View receipt')
    expect(modalHtml).toContain('View credit note')
    expect(modalHtml).not.toContain('Open checkout')
  })
})
