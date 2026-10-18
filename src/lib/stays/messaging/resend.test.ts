/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from './test-support'
import { resendToGuest } from './resend'

const mk = () => {
  const db = new FakeDb() as any
  db.tables.stays = [{
    id: 's1', account_id: 'a', property_id: 'p1', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919876543210',
    form_token: 'tok123tok123ab', automation_ready: true, status: 'registered',
    checkin_at: new Date(Date.now() + 86_400_000).toISOString(), checkout_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  }]
  db.tables.stay_guests = [{ id: 'g1', stay_id: 's1', full_name: 'Ravi', id_rejected_at: '2026-10-18T00:00:00Z', id_reject_reason: 'Photo is blurry' }]
  db.tables.properties = [{ id: 'p1', name: 'Mahinoor Villa' }]
  db.tables.stay_messages = [{ id: 'm1', account_id: 'a', stay_id: 's1', message_key: 'form_link', status: 'failed', attempts: 3, last_error: 'x' }]
  return db
}
const base = { accountId: 'a', stayId: 's1', requestUrl: 'https://desk.example.com/api/x' }

describe('resend to guest', () => {
  it('sends a scheduled message again and marks it sent', async () => {
    const db = mk()
    const transport = vi.fn(async () => ({ messageId: 'WA1' }))
    const r = await resendToGuest(db, { ...base, target: { type: 'message', messageKey: 'form_link' }, transport })
    expect(r).toEqual({ ok: true })
    expect((transport.mock.calls[0] as any[])[0].text).toContain('https://desk.example.com/stay/tok123tok123ab')
    expect(db.tables.stay_messages[0]).toMatchObject({ status: 'sent', last_error: null })
  })
  it('sends the ID rejected message again with the saved reason', async () => {
    const db = mk()
    const transport = vi.fn(async () => ({ messageId: 'WA2' }))
    expect(await resendToGuest(db, { ...base, target: { type: 'id_rejected', guestId: 'g1' }, transport })).toEqual({ ok: true })
    expect((transport.mock.calls[0] as any[])[0].text).toContain('Photo is blurry')
  })
  it('says why when it cannot be sent', async () => {
    const db = mk()
    const r = await resendToGuest(db, { ...base, target: { type: 'message', messageKey: 'form_link' }, transport: async () => { throw new Error('boom') } })
    expect(r).toMatchObject({ ok: false, error: 'not_sent' })
  })
  it('refuses staff alerts, unknown keys, an ID that is not rejected, and a stay without a mobile', async () => {
    const db = mk()
    expect(await resendToGuest(db, { ...base, target: { type: 'message', messageKey: 'owner_alert' } })).toMatchObject({ error: 'not_allowed' })
    expect(await resendToGuest(db, { ...base, target: { type: 'message', messageKey: 'nope' } })).toMatchObject({ error: 'not_allowed' })
    db.tables.stay_guests[0].id_rejected_at = null
    expect(await resendToGuest(db, { ...base, target: { type: 'id_rejected', guestId: 'g1' } })).toMatchObject({ error: 'nothing_to_resend' })
    db.tables.stays[0].guest_phone = null
    expect(await resendToGuest(db, { ...base, target: { type: 'message', messageKey: 'form_link' } })).toMatchObject({ error: 'no_mobile' })
  })
})
