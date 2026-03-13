import { beforeEach, describe, expect, it } from 'vitest'
import adminConfigHtml from '../config.html?raw'
import adminConfigCode from '../js/pages/config.js?raw'
import adminIndexHtml from '../index.html?raw'
import adminSessionTypesHtml from '../session-types.html?raw'
import adminContactMessagesHtml from '../contact-messages.html?raw'

function evalCode(code) { (0, eval)(code) }

describe('admin config page', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = adminConfigHtml
    window.adminClient = {
      requestJson: async (path) => {
        if (path !== '/admin/config') throw new Error(`Unexpected path: ${path}`)
        return {
          timing_delays: {
            config_path: 'apps/api-booking/src/config/booking-policy.json',
            entries: [
              {
                name: 'Admin manage token expiry',
                keyname: 'adminManageTokenExpiryMinutes',
                value: 30,
                description: 'Minutes that a generated admin manage token stays valid after creation.',
              },
              {
                name: 'Stale processing timeout',
                keyname: 'sideEffectProcessingTimeoutMinutes',
                value: 10,
                description: 'Minutes after which a stuck processing side effect is reset back to pending.',
              },
            ],
          },
        }
      },
    }
  })

  it('renders the timing and delays tab, config path, and timing table rows', async () => {
    evalCode(adminConfigCode)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.tab-btn.active')?.textContent).toBe('Timing & Delays')
    expect(document.getElementById('configPath')?.textContent).toBe('apps/api-booking/src/config/booking-policy.json')

    const rows = Array.from(document.querySelectorAll('#timingBody tr'))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Admin manage token expiry')
    expect(rows[0]?.textContent).toContain('adminManageTokenExpiryMinutes')
    expect(rows[0]?.textContent).toContain('30')
  })

  it('adds the config link to the side menu across admin pages', () => {
    expect(adminConfigHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminIndexHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminSessionTypesHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminContactMessagesHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
  })
})
