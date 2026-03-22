import { beforeEach, describe, expect, it } from 'vitest'
import managePageCode from '../js/pages/manage.js?raw'
import mockEmailPreviewCode from '../js/mock-email-preview.js?raw'

function evalCode(code) {
  // Evaluate in the browser-like global scope
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('manage page reschedule link type', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="manage-card"></div>
      <dialog id="cancel-dialog" hidden></dialog>
      <p id="cancel-dialog-msg"></p>
      <button id="cancel-no"></button>
      <button id="cancel-yes"></button>
    `
    window.API_BASE = ''
    window.getSiteApiBase = () => ''
    window.siteClient = {
      requestJson: async () => ({}),
      detectUiTestMode: () => 'playwright',
      resolveHomepageHref: () => new URL('/index.html', window.location.origin).toString(),
      maybeRenderMockEmailPreview: async (data) => {
        if (data && data.mock_email_preview) {
          window.IlluminateMockEmailPreview.render({ preview: data.mock_email_preview })
        }
      },
    }
    window.buildAtcWidget = (event) => `<div class="atc-widget" data-atc-title="${event.title}">Add to calendar</div>`
    window.initAddToCalendar = () => {}
    window.history.replaceState({}, '', '/manage.html?token=tok-123')
    evalCode(mockEmailPreviewCode)
  })

  it('uses session slots for a 90-minute first session reschedule', async () => {
    window.siteClient.requestJson = async () => ({
      source: 'session',
      booking_id: 'booking-1',
      status: 'CONFIRMED',
      starts_at: '2026-03-20T09:00:00.000Z',
      ends_at: '2026-03-20T10:30:00.000Z',
      title: 'First Clarity Session',
      client: { first_name: 'A', last_name: 'B' },
      actions: { can_reschedule: true, can_cancel: false },
      policy: {},
    })

    evalCode(managePageCode)
    await flush()

    const href = document.querySelector('.manage-actions a.btn.btn-primary')?.getAttribute('href')
    expect(href).toContain('book.html?')
    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1))
    expect(query.get('type')).toBe('session')
    expect(query.get('mode')).toBe('reschedule')
  })

  it('keeps intro slots for a 30-minute intro reschedule', async () => {
    window.siteClient.requestJson = async () => ({
      source: 'session',
      booking_id: 'booking-2',
      status: 'CONFIRMED',
      starts_at: '2026-03-20T09:00:00.000Z',
      ends_at: '2026-03-20T09:30:00.000Z',
      title: 'Introductory Clarity Conversation',
      client: { first_name: 'A', last_name: 'B' },
      actions: { can_reschedule: true, can_cancel: false },
      policy: {},
    })

    evalCode(managePageCode)
    await flush()

    const href = document.querySelector('.manage-actions a.btn.btn-primary')?.getAttribute('href')
    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1))
    expect(query.get('type')).toBe('intro')
  })

  it('renders the captured cancellation email after a successful cancel in mock mode', async () => {
    let callCount = 0
    window.siteClient.requestJson = async (_path, init) => {
      callCount += 1
      if (callCount === 1) {
        return {
          source: 'session',
          booking_id: 'booking-3',
          status: 'CONFIRMED',
          starts_at: '2026-03-20T09:00:00.000Z',
          ends_at: '2026-03-20T10:30:00.000Z',
          title: 'First Clarity Session',
          client: { first_name: 'A', last_name: 'B' },
          actions: { can_reschedule: false, can_cancel: true },
          policy: {},
        }
      }
      expect(init.method).toBe('POST')
      const response = {
        booking_id: 'booking-3',
        status: 'CANCELED',
        result_code: 'CANCELED',
        message: "Your cancellation has been registered. If a refund applies, you'll receive a separate confirmation email.",
        mock_email_preview: {
          email_id: 'mock_msg_cancel',
          to: 'cancel@example.test',
          subject: 'Booking cancelled',
          html_url: 'https://api.letsilluminate.co/api/__dev/emails/mock_msg_cancel/html',
          html_content: '<html><body><p>Your booking has been cancelled.</p></body></html>',
        },
      }
      await window.siteClient.maybeRenderMockEmailPreview(response)
      return response
    }

    evalCode(managePageCode)
    await flush()

    document.getElementById('cancel-btn').click()
    document.getElementById('cancel-yes').click()
    await flush()
    await flush()

    expect(document.querySelector('#mock-email-preview-overlay .mock-email-preview__frame')?.srcdoc).toContain('cancelled')
    expect(document.querySelector('.manage-subtitle')?.textContent).toContain('If a refund applies')
  })

  it('renders add-to-calendar for confirmed bookings on manage page', async () => {
    window.siteClient.requestJson = async () => ({
      source: 'session',
      booking_id: 'booking-4',
      status: 'CONFIRMED',
      starts_at: '2026-03-20T09:00:00.000Z',
      ends_at: '2026-03-20T10:30:00.000Z',
      title: 'First Clarity Session',
      client: { first_name: 'A', last_name: 'B' },
      actions: { can_reschedule: false, can_cancel: false },
      policy: {},
      calendar_event: {
        title: 'Clarity Session — ILLUMINATE by Yair Benharroch',
        start: '2026-03-20T09:00:00.000Z',
        end: '2026-03-20T10:30:00.000Z',
        timezone: 'Europe/Zurich',
        location: 'Lugano',
        description: '1:1 Clarity Session with Yair Benharroch.',
      },
      calendar_sync_pending_retry: false,
    })

    evalCode(managePageCode)
    await flush()

    expect(document.querySelector('#manage-card .atc-widget')?.getAttribute('data-atc-title')).toBe('Clarity Session — ILLUMINATE by Yair Benharroch')
  })

  it('renders homepage links against the current origin', async () => {
    window.siteClient.requestJson = async () => ({
      source: 'session',
      booking_id: 'booking-5',
      status: 'CONFIRMED',
      starts_at: '2026-03-20T09:00:00.000Z',
      ends_at: '2026-03-20T10:30:00.000Z',
      title: 'First Clarity Session',
      client: { first_name: 'A', last_name: 'B' },
      actions: { can_reschedule: false, can_cancel: false },
      policy: {},
    })

    evalCode(managePageCode)
    await flush()

    const homepageLink = Array.from(document.querySelectorAll('.manage-actions a'))
      .find((link) => link.textContent.includes('Homepage'))
    expect(homepageLink?.getAttribute('href')).toBe(`${window.location.origin}/index.html`)
  })

  it('renders a complete payment action when the backend exposes it for unpaid bookings', async () => {
    window.siteClient.requestJson = async () => ({
      source: 'session',
      booking_id: 'booking-6',
      status: 'CONFIRMED',
      starts_at: '2026-03-20T09:00:00.000Z',
      ends_at: '2026-03-20T10:30:00.000Z',
      title: 'Cycle Session',
      client: { first_name: 'A', last_name: 'B' },
      actions: {
        can_reschedule: false,
        can_cancel: false,
        can_complete_payment: true,
        continue_payment_url: '/continue-payment.html?token=m1.booking-6',
      },
      policy: {},
    })

    evalCode(managePageCode)
    await flush()

    const paymentLink = Array.from(document.querySelectorAll('.manage-actions a'))
      .find((link) => link.textContent.includes('Complete payment'))
    expect(paymentLink?.getAttribute('href')).toBe('/continue-payment.html?token=m1.booking-6')
  })
})
