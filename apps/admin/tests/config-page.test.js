import { beforeEach, describe, expect, it, vi } from 'vitest'
import adminConfigHtml from '../config.html?raw'
import adminConfigCode from '../js/pages/config.js?raw'
import adminIndexHtml from '../index.html?raw'
import adminSessionTypesHtml from '../session-types.html?raw'
import adminContactMessagesHtml from '../contact-messages.html?raw'

function evalCode(code) { (0, eval)(code) }

const initialPayload = {
  timing_delays: {
    config_source: 'public.system_settings',
    domains: ['admin', 'payment', 'processing'],
    value_types: ['integer', 'float', 'boolean', 'text', 'json'],
    entries: [
      {
        domain: 'admin',
        name: 'Admin manage token expiry',
        readable_name: 'Admin manage token expiry',
        keyname: 'adminManageTokenExpiryMinutes',
        value_type: 'integer',
        unit: 'minutes',
        value: '30',
        description: 'Time an admin-generated management token remains valid.',
        description_he: 'מספר הדקות שטוקן ניהול שנוצר על ידי אדמין נשאר תקף.',
        description_display: 'מספר הדקות שטוקן ניהול שנוצר על ידי אדמין נשאר תקף.',
      },
      {
        domain: 'payment',
        name: 'Pay-now reminder grace period',
        readable_name: 'Pay-now reminder grace period',
        keyname: 'payNowReminderGraceMinutes',
        value_type: 'integer',
        unit: 'minutes',
        value: '10',
        description: 'Delay before sending a reminder to complete an unfinished pay-now checkout.',
        description_he: 'עיכוב קצר לפני שליחת תזכורת להשלמת תשלום שהתחיל אך לא הסתיים.',
        description_display: 'עיכוב קצר לפני שליחת תזכורת להשלמת תשלום שהתחיל אך לא הסתיים.',
      },
      {
        domain: 'processing',
        name: 'Stale processing timeout',
        readable_name: 'Stale processing timeout',
        keyname: 'sideEffectProcessingTimeoutMinutes',
        value_type: 'integer',
        unit: 'minutes',
        value: '10',
        description: 'Time after which a stuck processing task is reset to pending.',
        description_he: 'מספר הדקות שלאחריהן עיבוד שנתקע מאופס חזרה למצב ממתין.',
        description_display: 'מספר הדקות שלאחריהן עיבוד שנתקע מאופס חזרה למצב ממתין.',
      },
    ],
  },
}

describe('admin config page', () => {
  let requestJson

  beforeEach(() => {
    document.documentElement.innerHTML = adminConfigHtml
    requestJson = vi.fn(async (path, init) => {
      if (path !== '/admin/config') throw new Error(`Unexpected path: ${path}`)
      if (!init) return initialPayload
      if (init.method === 'POST') {
        return {
          timing_delays: {
            ...initialPayload.timing_delays,
            domains: ['admin', 'notifications', 'payment', 'processing'],
            entries: [
              ...initialPayload.timing_delays.entries,
              {
                domain: 'notifications',
                name: 'Welcome delay',
                readable_name: 'Welcome delay',
                keyname: 'welcomeDelayMinutes',
                value_type: 'integer',
                unit: 'minutes',
                value: '15',
                description: 'Delay before the welcome email is sent.',
                description_he: 'מספר הדקות לפני שליחת מייל ברוכים הבאים.',
                description_display: 'מספר הדקות לפני שליחת מייל ברוכים הבאים.',
              },
            ],
          },
        }
      }
      throw new Error(`Unexpected method: ${init.method}`)
    })
    window.adminClient = { requestJson }
  })

  it('renders DB-backed settings and sorts by domain then value', async () => {
    evalCode(adminConfigCode)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.tab-btn.active')?.textContent).toBe('Timing & Delays')
    expect(document.getElementById('configPath')?.textContent).toBe('public.system_settings')

    const domainFilter = document.getElementById('domainFilter')
    expect(Array.from(domainFilter.options).map((option) => option.value)).toEqual(['', 'admin', 'payment', 'processing'])

    const rows = Array.from(document.querySelectorAll('#timingBody tr'))
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('admin')
    expect(rows[0]?.textContent).toContain('Admin manage token expiry')
    expect(rows[0]?.textContent).toContain('30')
    expect(rows[1]?.textContent).toContain('payment')
    expect(rows[1]?.textContent).toContain('Pay-now reminder grace period')
    expect(rows[1]?.textContent).toContain('10')
    expect(rows[2]?.textContent).toContain('processing')
    expect(rows[2]?.textContent).toContain('Stale processing timeout')
  })

  it('opens the add-setting modal and posts a new DB setting', async () => {
    evalCode(adminConfigCode)
    await new Promise((resolve) => setTimeout(resolve, 0))

    document.getElementById('addSettingBtn')?.click()
    expect(document.getElementById('editTitle')?.textContent).toBe('Add setting')

    const domainSelect = document.getElementById('editDomainSelect')
    domainSelect.value = '__enter_new__'
    domainSelect.dispatchEvent(new Event('change'))
    document.getElementById('editDomainCustom').value = 'notifications'
    document.getElementById('editKeyname').value = 'welcomeDelayMinutes'
    document.getElementById('editReadableName').value = 'Welcome delay'
    document.getElementById('editValueType').value = 'integer'
    document.getElementById('editUnit').value = 'minutes'
    document.getElementById('editValue').value = '15'
    document.getElementById('editDescription').value = 'Delay before the welcome email is sent.'
    document.getElementById('editDescriptionHe').value = 'מספר הדקות לפני שליחת מייל ברוכים הבאים.'

    document.getElementById('editSave').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requestJson).toHaveBeenCalledWith('/admin/config', expect.objectContaining({
      method: 'POST',
    }))
    const body = JSON.parse(requestJson.mock.calls[1][1].body)
    expect(body).toEqual(expect.objectContaining({
      domain: 'notifications',
      keyname: 'welcomeDelayMinutes',
      value_type: 'integer',
      value: '15',
    }))
    expect(document.querySelectorAll('#timingBody tr')).toHaveLength(4)
  })

  it('filters by domain and free-text search', async () => {
    evalCode(adminConfigCode)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const domainFilter = document.getElementById('domainFilter')
    domainFilter.value = 'processing'
    domainFilter.dispatchEvent(new Event('change'))

    let rows = Array.from(document.querySelectorAll('#timingBody tr'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Stale processing timeout')

    domainFilter.value = ''
    domainFilter.dispatchEvent(new Event('change'))
    const searchInput = document.getElementById('searchInput')
    searchInput.value = 'grace'
    searchInput.dispatchEvent(new Event('input'))

    rows = Array.from(document.querySelectorAll('#timingBody tr'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Pay-now reminder grace period')
  })

  it('adds the config link to the side menu across admin pages', () => {
    expect(adminConfigHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminIndexHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminSessionTypesHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
    expect(adminContactMessagesHtml).toContain('href="config.html" class="admin-nav-link" data-page="config">Config</a>')
  })
})
