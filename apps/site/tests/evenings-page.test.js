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
})
