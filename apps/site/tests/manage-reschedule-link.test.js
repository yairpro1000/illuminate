import { beforeEach, describe, expect, it } from 'vitest'
import managePageCode from '../js/pages/manage.js?raw'

function evalCode(code) {
  // Evaluate in the browser-like global scope
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function buildJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return 'application/json; charset=utf-8'
        return null
      },
    },
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
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
    window.history.replaceState({}, '', '/manage.html?token=tok-123')
  })

  it('uses session slots for a 90-minute first session reschedule', async () => {
    window.fetch = async () => buildJsonResponse({
      source: 'session',
      booking_id: 'booking-1',
      status: 'SLOT_CONFIRMED',
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
    window.fetch = async () => buildJsonResponse({
      source: 'session',
      booking_id: 'booking-2',
      status: 'SLOT_CONFIRMED',
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
})
