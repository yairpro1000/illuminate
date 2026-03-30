import { beforeEach, describe, expect, it, vi } from 'vitest'
import rebookPageCode from '../js/pages/rebook.js?raw'
import bookSharedCode from '../js/book-shared.js?raw'

function evalCode(code) {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('rebook page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="rebook-card"></div>'
    window.siteClient = {
      config: {
        sessionsHref: 'sessions.html',
        eveningsHref: 'evenings.html',
      },
      requestJson: vi.fn(),
      resolveHomepageHref: vi.fn(() => 'index.html'),
    }
  })

  it('forwards the selected paid session offer slug into the new booking link', async () => {
    window.history.replaceState({}, '', '/rebook.html?source=session&admin_token=adm1')
    window.siteClient.requestJson.mockResolvedValue({
      session_types: [
        {
          id: 'st-paid-2',
          slug: 'deep-dive-session',
          title: 'Deep Dive Session',
          price: 220,
          currency: 'CHF',
          duration_minutes: 90,
        },
      ],
    })

    evalCode(rebookPageCode)
    await flush()

    const link = document.querySelector('.rebook-pill')
    expect(link).not.toBeNull()
    const href = link.getAttribute('href')
    const url = new URL(href, 'https://site.local/')
    expect(url.pathname).toBe('/book.html')
    expect(url.searchParams.get('type')).toBe('session')
    expect(url.searchParams.get('offer')).toBe('deep-dive-session')
    expect(url.searchParams.get('admin_token')).toBe('adm1')
  })

  it('renders source=event options from the events payload instead of falling into the generic error state', async () => {
    window.history.replaceState({}, '', '/rebook.html?source=event&prefill_first=Yair')
    window.siteClient.requestJson.mockResolvedValue({
      events: [
        {
          id: 'ev-1',
          slug: 'evening-clarity',
          title: 'Evening of Clarity',
          starts_at: '2026-04-10T18:00:00Z',
          ends_at: '2026-04-10T20:00:00Z',
          address_line: 'Lugano',
          is_paid: true,
          price_per_person: 45,
          currency: 'CHF',
          render: {
            is_past: false,
            public_registration_open: true,
            sold_out: false,
          },
        },
      ],
    })

    evalCode(rebookPageCode)
    await flush()

    const cardText = document.getElementById('rebook-card').textContent.replace(/\s+/g, ' ')
    expect(cardText).toContain('Book an event')
    expect(cardText).toContain('Evening of Clarity')
    expect(cardText).not.toContain('Could not load options')

    const link = document.querySelector('.rebook-pill')
    const href = link.getAttribute('href')
    const url = new URL(href, 'https://site.local/')
    expect(url.searchParams.get('source')).toBe('evening')
    expect(url.searchParams.get('eventSlug')).toBe('evening-clarity')
    expect(url.searchParams.get('prefill_first')).toBe('Yair')
  })
})

describe('book page context parsing', () => {
  beforeEach(() => {
    window.siteClient = {
      config: {},
    }
  })

  it('keeps admin_token in evening booking context', () => {
    window.history.replaceState({}, '', '/book.html?source=evening&eventSlug=ev-1&admin_token=adm-event')

    evalCode(bookSharedCode)

    expect(window.BookPageShared.parseBookingContext()).toEqual(
      expect.objectContaining({
        source: 'evening',
        eventSlug: 'ev-1',
        adminToken: 'adm-event',
      }),
    )
  })
})
