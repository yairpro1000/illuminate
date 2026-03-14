import { beforeEach, describe, expect, it, vi } from 'vitest'
import eveningsPageCode from '../js/evenings.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('evenings page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="events-grid"></div>'
    window.buildAtcWidget = undefined
    window.initAddToCalendar = undefined
    window.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    window.siteClient = {
      requestJson: vi.fn(),
    }
  })

  it('suppresses console noise when the events request is aborted during page teardown', async () => {
    let rejectRequest
    window.siteClient.requestJson.mockImplementation(
      () => new Promise((_, reject) => {
        rejectRequest = reject
      }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    evalCode(eveningsPageCode)
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    rejectRequest(new DOMException('The operation was aborted.', 'AbortError'))
    await flush()

    expect(errorSpy).not.toHaveBeenCalled()
    expect(document.getElementById('events-grid').textContent).toBe('')
    errorSpy.mockRestore()
  })

  it('renders an error state for a real events load failure', async () => {
    window.siteClient.requestJson.mockRejectedValue(new Error('Internal server error'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    evalCode(eveningsPageCode)
    await flush()

    expect(errorSpy).toHaveBeenCalled()
    expect(document.getElementById('events-grid').textContent).toContain('Could not load events')
    errorSpy.mockRestore()
  })

  it('renders integer prices without decimals and preserves real decimal prices', async () => {
    window.siteClient.requestJson.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          slug: 'event-1',
          title: 'First event',
          description: 'Description',
          starts_at: '2026-06-19T17:00:00Z',
          ends_at: '2026-06-19T19:00:00Z',
          address_line: 'Lugano',
          is_paid: true,
          price_per_person: 100,
          currency: 'CHF',
          capacity: 10,
          render: { is_past: false, public_registration_open: true, show_reminder_signup_cta: false, sold_out: false },
          stats: { active_bookings: 1, capacity: 10 },
        },
        {
          id: 'event-2',
          slug: 'event-2',
          title: 'Second event',
          description: 'Description',
          starts_at: '2026-07-19T17:00:00Z',
          ends_at: '2026-07-19T19:00:00Z',
          address_line: 'Lugano',
          is_paid: true,
          price_per_person: 100.99,
          currency: 'CHF',
          capacity: 10,
          render: { is_past: false, public_registration_open: true, show_reminder_signup_cta: false, sold_out: false },
          stats: { active_bookings: 1, capacity: 10 },
        },
      ],
    })

    evalCode(eveningsPageCode)
    await flush()

    const priceRows = Array.from(document.querySelectorAll('.event-card__meta-row dd')).map((node) => node.textContent)
    expect(priceRows).toContain('CHF 100')
    expect(priceRows).toContain('CHF 100.99')
    expect(priceRows).not.toContain('CHF 100.00')
  })
})
