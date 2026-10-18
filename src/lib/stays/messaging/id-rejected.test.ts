/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from './test-support'
import { StayWaitError } from './send'
import { idRejectedText, sendIdRejectedMessage } from './id-rejected'

const mkDb = () => {
  const db = new FakeDb() as any
  db.tables.stays = [{
    id: 's1', account_id: 'a', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919876543210',
    form_token: 'tok123tok123ab', property_id: 'p1', automation_ready: true, status: 'registered',
    checkin_at: new Date(Date.now() + 86_400_000).toISOString(), checkout_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  }]
  db.tables.stay_guests = [{ id: 'g1', full_name: 'Ravi Rao' }]
  db.tables.properties = [{ id: 'p1', name: 'Mahinoor Villa' }]
  return db
}
const args = { accountId: 'a', stayId: 's1', guestId: 'g1', reason: 'Photo is blurry', requestUrl: 'https://desk.example.com/api/x' }

describe('ID rejected message', () => {
  it('goes out at once with the reason and the upload link, outside the send window too', async () => {
    const db = mkDb()
    const transport = vi.fn(async () => ({ messageId: 'WA9' }))
    const r = await sendIdRejectedMessage(db, { ...args, transport })
    expect(r).toBe('sent')
    const sent = (transport.mock.calls[0] as any[])[0]
    expect(sent.kind).toBe('reply') // not held to 09:00-20:00
    expect(sent.phone).toBe('919876543210')
    expect(sent.text).toContain('Photo is blurry')
    expect(sent.text).toContain('https://desk.example.com/stay/tok123tok123ab')
    expect(sent.text).toContain('Ravi Rao')
  })

  it('the reason is never written to the message log', async () => {
    const db = mkDb()
    await sendIdRejectedMessage(db, { ...args, transport: async () => ({ messageId: 'WA9' }) })
    expect(JSON.stringify(db.tables.stay_message_log)).not.toContain('blurry')
  })

  it('when it cannot be sent, the team is told and nothing is marked sent', async () => {
    const db = mkDb()
    const r = await sendIdRejectedMessage(db, { ...args, transport: async () => { throw new StayWaitError('paused') } })
    expect(r).toBe('not_sent')
  })

  it('a stay without a mobile number sends nothing', async () => {
    const db = mkDb()
    db.tables.stays[0].guest_phone = null
    const transport = vi.fn()
    expect(await sendIdRejectedMessage(db, { ...args, transport })).toBe('not_sent')
    expect(transport).not.toHaveBeenCalled()
  })

  it('wording', () => {
    expect(idRejectedText({ firstName: 'Asha', guestName: '', reason: 'Expired', formUrl: 'https://x/stay/t' })).toMatch(/Hi Asha, we could not accept the ID\./)
  })
})
