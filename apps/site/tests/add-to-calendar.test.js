import { beforeEach, describe, expect, it } from 'vitest'
import addToCalendarCode from '../js/add-to-calendar.js?raw'

function evalCode(code) {
  // Evaluate in the browser-like global scope
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
}

function loadAtcApi() {
  evalCode(`${addToCalendarCode}\nwindow.__atc = { buildAtcWidget, initAddToCalendar };`)
  return window.__atc
}

function readBlobText(blob) {
  if (blob && typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'))
    reader.readAsText(blob)
  })
}

describe('site add-to-calendar.js', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete window.__atc
  })

  it('normalizes mixed timezone start/end for Google and Outlook links', () => {
    const { buildAtcWidget, initAddToCalendar } = loadAtcApi()

    document.body.innerHTML = buildAtcWidget({
      title: 'Clarity Session',
      start: '2026-03-20T19:00:00+01:00',
      end: '2026-03-20T18:30:00.000Z',
      location: 'Lugano',
      description: '1:1 session',
    })
    initAddToCalendar(document)

    const googleHref = document.querySelector('[data-atc-google]').href
    const googleUrl = new URL(googleHref)
    expect(googleUrl.searchParams.get('dates')).toBe('20260320T190000/20260320T193000')
    expect(googleUrl.searchParams.get('ctz')).toBe('Europe/Zurich')

    const outlookHref = document.querySelector('[data-atc-outlook]').href
    const outlookUrl = new URL(outlookHref)
    expect(outlookUrl.searchParams.get('startdt')).toBe('2026-03-20T19:00:00')
    expect(outlookUrl.searchParams.get('enddt')).toBe('2026-03-20T19:30:00')
  })

  it('writes corrected DTSTART/DTEND in downloaded ICS', async () => {
    const { buildAtcWidget, initAddToCalendar } = loadAtcApi()
    document.body.innerHTML = buildAtcWidget({
      title: 'Clarity Session',
      start: '2026-03-20T19:00:00+01:00',
      end: '2026-03-20T18:30:00.000Z',
      location: 'Lugano',
      description: '1:1 session',
    })
    initAddToCalendar(document)

    let capturedBlob = null
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const originalAnchorClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (blob) => {
      capturedBlob = blob
      return 'blob:test'
    }
    URL.revokeObjectURL = () => {}
    HTMLAnchorElement.prototype.click = () => {}

    try {
      const btn = document.querySelector('[data-atc-ics]')
      btn.click()
      expect(capturedBlob).toBeTruthy()
      const icsText = await readBlobText(capturedBlob)
      expect(icsText).toContain('DTSTART;TZID=Europe/Zurich:20260320T190000')
      expect(icsText).toContain('DTEND;TZID=Europe/Zurich:20260320T193000')
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      HTMLAnchorElement.prototype.click = originalAnchorClick
    }
  })
})
