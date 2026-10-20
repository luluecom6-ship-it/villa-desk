/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from './test-support'
import { sendFormReceivedMessage } from './form-received'

const mkDb = () => {
  const db = new FakeDb() as any
  db.tables.stays = [{
    id: 's1', account_id: 'a', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919876543210',
    form_token: 'tok', property_id: 'p1', automation_ready: true, status: 'registered',
    checkin_at: new Date(Date.now() + 86_400_000).toISOString(), checkout_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  }]
  db.tables.properties = [{ id: 'p1', name: 'Mahinoor Villa' }]
  return db
}

describe('form received message', () => {
  it('tells the guest the form is pending review, with no ID details', async () => {
    const db = mkDb()
    const transport = vi.fn(async () => ({ messageId: 'W1' }))
    expect(await sendFormReceivedMessage(db, { accountId: 'a', stayId: 's1', transport })).toBe('sent')
    const sent = (transport.mock.calls[0] as any[])[0]
    expect(sent.phone).toBe('919876543210')
    expect(sent.text).toContain('Hi Asha')
    expect(sent.text).toContain('pending review')
  })
  it('sends nothing without a mobile number', async () => {
    const db = mkDb()
    db.tables.stays[0].guest_phone = null
    const transport = vi.fn()
    expect(await sendFormReceivedMessage(db, { accountId: 'a', stayId: 's1', transport })).toBe('not_sent')
    expect(transport).not.toHaveBeenCalled()
  })
})
