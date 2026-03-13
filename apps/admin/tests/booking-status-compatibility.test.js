import { describe, expect, it } from 'vitest'
import adminIndexHtml from '../index.html?raw'

describe('admin booking status compatibility', () => {
  it('uses only current Phase-2 booking statuses', () => {
    expect(adminIndexHtml).toContain('<option value="PENDING">PENDING</option>')
    expect(adminIndexHtml).toContain('<option value="CONFIRMED">CONFIRMED</option>')
    expect(adminIndexHtml).toContain('<option value="EXPIRED">EXPIRED</option>')
    expect(adminIndexHtml).toContain('<option value="CANCELED">CANCELED</option>')
    expect(adminIndexHtml).toContain('<option value="COMPLETED">COMPLETED</option>')
    expect(adminIndexHtml).toContain('<option value="NO_SHOW">NO_SHOW</option>')

    expect(adminIndexHtml).not.toContain('PENDING_CONFIRMATION')
    expect(adminIndexHtml).not.toContain('SLOT_CONFIRMED')
    expect(adminIndexHtml).not.toContain('<option value="PAID">')
    expect(adminIndexHtml).not.toContain('<option value="REFUNDED">')
  })
})
