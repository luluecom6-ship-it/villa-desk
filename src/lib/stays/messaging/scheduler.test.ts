/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory stand-in for the Supabase client */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendStayWhatsApp } from './send'
import { runStayScheduler, MAX_ATTEMPTS, RETRY_DELAY_MS, settleInterrupted } from './scheduler'

// A tiny in-memory stand-in for the Supabase client: just the calls the
// scheduler makes (select/update/insert/upsert with eq/in/lte/gte/is/order/limit).

import { FakeDb, type Row } from './test-support'

const ist = (s: string) => new Date(s.replace(' ', 'T') + ':00+05:30')
const REQUEST = 'https://villa.test/api/stays/cron'

let db: FakeDb
let transport: ReturnType<typeof vi.fn>

function seed(over: Row = {}) {
  db = new FakeDb()
  db.tables.properties = [{ id: 'p1', name: 'Mahinoor Stays', address: '12 MG Road', map_url: 'https://maps.test/x', directions: '', review_url: 'https://r.test', access_instructions: 'Code 1234', caretaker_phone: '+919800000000', default_checkin_time: '14:00:00', default_checkout_time: '11:00:00', deposit_refund_days: 3 }]
  db.tables.stays = [{
    id: 's1', account_id: 'a1', property_id: 'p1', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919000011111',
    status: 'registered', form_status: 'pending', form_token: 'abcdef0123456a', automation_ready: true,
    checkin_at: ist('2026-11-10 14:00').toISOString(), checkout_at: ist('2026-11-12 11:00').toISOString(), created_at: ist('2026-11-05 10:30').toISOString(),
    ...over,
  }]
  db.tables.profiles = [{ user_id: 'u-owner', account_id: 'a1', account_role: 'owner' }, { user_id: 'u-care', account_id: 'a1', account_role: 'agent' }]
  transport = vi.fn(async () => ({ messageId: 'wamid.1' }))
}
const run = (now: Date) => runStayScheduler(db as any, { requestUrl: REQUEST, now, transport: transport as any })
const msg = (key: string) => db.tables.stay_messages.find((m) => m.message_key === key)!
const log = (outcome: string) => (db.tables.stay_message_log ?? []).filter((l) => l.outcome === outcome)

beforeEach(() => seed())

describe('enqueue', () => {
  it('queues all eleven messages for a ready stay and sends only the form link at first', async () => {
    const s = await run(ist('2026-11-05 11:00'))
    expect(db.tables.stay_messages).toHaveLength(11)
    expect(s.sent).toBe(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const args = transport.mock.calls[0][0]
    expect(args.phone).toBe('919000011111')
    expect(args.text).toContain('https://villa.test/stay/abcdef0123456a')
    expect(args.text).toContain('MS-2026-001')
    expect(msg('form_link').status).toBe('sent')
    expect(msg('arrival_info').status).toBe('queued')
  })

  it('does not queue anything for a stay that is not ready for automation (no mobile)', async () => {
    seed({ automation_ready: false, guest_phone: null, status: 'draft' })
    const s = await run(ist('2026-11-05 11:00'))
    expect(db.tables.stay_messages ?? []).toHaveLength(0)
    expect(transport).not.toHaveBeenCalled()
    expect(s.sent).toBe(0)
  })

  it('skips reminders whose day already passed when the stay is first seen', async () => {
    seed({ created_at: ist('2026-11-08 12:00').toISOString() })
    await run(ist('2026-11-08 12:30'))
    expect(msg('form_reminder_3d').status).toBe('skipped_condition')
    expect(msg('form_reminder_2d').status).toBe('skipped_condition')
    expect(msg('form_reminder_1d').status).toBe('queued')
    expect(transport).toHaveBeenCalledTimes(1) // just the form link
  })

  it('moves queued messages when the dates are edited', async () => {
    await run(ist('2026-11-05 11:00'))
    const before = msg('arrival_info').due_at
    db.tables.stays[0].checkin_at = ist('2026-11-12 14:00').toISOString()
    db.tables.stays[0].checkout_at = ist('2026-11-14 11:00').toISOString()
    await run(ist('2026-11-05 11:15'))
    expect(msg('arrival_info').due_at).not.toBe(before)
  })
})

describe('double runs', () => {
  it('a second run in the same minute sends nothing more', async () => {
    const now = ist('2026-11-05 11:00')
    await run(now)
    await run(now)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(db.tables.stay_messages).toHaveLength(11)
  })

  it('two overlapping runs never send the same message twice', async () => {
    const now = ist('2026-11-05 11:00')
    await Promise.all([run(now), run(now)])
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('the gate', () => {
  it('blocks and logs when the stay lost automation between queueing and sending', async () => {
    await run(ist('2026-11-05 09:30')) // enqueue; form_link due 10:30 not yet
    db.tables.stays[0].automation_ready = false // staff paused automation
    const s = await run(ist('2026-11-05 11:00'))
    expect(transport).not.toHaveBeenCalled()
    expect(s.blocked).toBe(1)
    expect(msg('form_link').status).toBe('blocked_not_registered')
    expect(log('blocked_not_registered')).toHaveLength(1)
    expect(log('blocked_not_registered')[0].phone_tail).toBe('1111')
  })

  it('blocks when the number on the stay was changed away from the queued stay', async () => {
    await run(ist('2026-11-05 09:30'))
    db.tables.stays[0].guest_phone = '123' // invalid
    await run(ist('2026-11-05 11:00'))
    expect(transport).not.toHaveBeenCalled()
  })

  it('never writes a full phone number into the log', async () => {
    await run(ist('2026-11-05 11:00'))
    for (const l of db.tables.stay_message_log) expect(JSON.stringify(l)).not.toContain('919000011111')
  })
})

describe('send window', () => {
  it('sends every message at any hour, as soon as it is due', async () => {
    const s = await run(ist('2026-11-05 21:00'))
    expect(transport).toHaveBeenCalledTimes(1)
    expect((transport.mock.calls[0] as any[])[0].kind).toBe('immediate')
    expect(msg('form_link').status).toBe('sent')
    expect(s.sent).toBe(1)
  })
})

describe('conditions at send time', () => {
  it('arrival info waits for the form, then goes once it is submitted', async () => {
    const day = ist('2026-11-09 10:05')
    await run(day)
    expect(msg('arrival_info').status).toBe('queued')
    db.tables.stays[0].form_status = 'submitted'
    await run(ist('2026-11-09 10:20'))
    expect(msg('arrival_info').status).toBe('sent')
    const texts = transport.mock.calls.map((c) => c[0].text as string)
    expect(texts.some((t) => t.includes('12 MG Road') && t.includes('14:00'))).toBe(true)
  })

  it('does not send the form reminders once the form is submitted', async () => {
    db.tables.stays[0].form_status = 'submitted'
    await run(ist('2026-11-07 10:05'))
    expect(msg('form_reminder_3d').status).toBe('skipped_condition')
    expect(transport).not.toHaveBeenCalled()
  })

  it('access details need verified IDs; the staff alert goes to owners and admins only', async () => {
    db.tables.stay_guests = [{ stay_id: 's1', is_adult: true, id_verified_at: null }]
    await run(ist('2026-11-09 17:05'))
    expect(msg('id_alert_staff').status).toBe('sent')
    const notes = db.tables.notifications ?? []
    expect(notes.map((n) => n.user_id)).toEqual(['u-owner'])
    expect(notes[0].type).toBe('stay_alert')
    await run(ist('2026-11-10 09:05'))
    expect(msg('access_details').status).toBe('queued')
    db.tables.stay_guests[0].id_verified_at = '2026-11-10T01:00:00Z'
    await run(ist('2026-11-10 09:20'))
    expect(msg('access_details').status).toBe('sent')
    expect(transport.mock.calls.some((c) => (c[0].text as string).includes('Code 1234'))).toBe(true)
  })

  it('cancelled stays send nothing', async () => {
    await run(ist('2026-11-05 09:30'))
    db.tables.stays[0].status = 'cancelled'
    await run(ist('2026-11-05 11:00'))
    expect(transport).not.toHaveBeenCalled()
    expect(msg('form_link').status).toBe('cancelled')
  })
})

describe('retries', () => {
  it('retries a failure 15 minutes later, then marks failed after 3 and alerts staff', async () => {
    transport.mockRejectedValue(Object.assign(new Error('boom with secret text'), { code: '131047' }))
    let now = ist('2026-11-05 11:00')
    await run(now)
    expect(msg('form_link')).toMatchObject({ status: 'queued', attempts: 1, last_error: '131047' })
    await run(new Date(now.getTime() + 5 * 60_000)) // too early
    expect(transport).toHaveBeenCalledTimes(1)
    now = new Date(now.getTime() + RETRY_DELAY_MS)
    await run(now)
    expect(msg('form_link').attempts).toBe(2)
    now = new Date(now.getTime() + RETRY_DELAY_MS)
    const s = await run(now)
    expect(MAX_ATTEMPTS).toBe(3)
    expect(msg('form_link')).toMatchObject({ status: 'failed', attempts: 3 })
    expect(s.failed).toBe(1)
    expect((db.tables.notifications ?? []).some((n) => /Message not sent/.test(n.title))).toBe(true)
    expect(JSON.stringify(db.tables.stay_message_log)).not.toContain('secret text')
  })
})

describe('interrupted runs', () => {
  it('a row stuck in sending is failed and flagged, never resent', async () => {
    db.tables.stay_messages = [{ id: 'm1', account_id: 'a1', stay_id: 's1', message_key: 'form_link', status: 'sending', updated_at: ist('2026-11-05 09:00').toISOString() }]
    const n = await settleInterrupted(db as any, ist('2026-11-05 10:00'))
    expect(n).toBe(1)
    expect(db.tables.stay_messages[0]).toMatchObject({ status: 'failed', last_error: 'interrupted' })
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('sendStayWhatsApp directly', () => {
  const base = { accountId: 'a1', phone: '919000011111', guestName: 'Asha', messageKey: 'form_link', text: 'hi', enforceWindow: false }
  it('sends for the stay that owns the number', async () => {
    const r = await sendStayWhatsApp(db as any, { ...base, stayId: 's1', now: ist('2026-11-05 11:00'), transport: transport as any })
    expect(r.outcome).toBe('sent')
  })
  it('refuses when the number belongs to a different stay', async () => {
    const r = await sendStayWhatsApp(db as any, { ...base, stayId: 'other', now: ist('2026-11-05 11:00'), transport: transport as any })
    expect(r).toEqual({ outcome: 'blocked', reason: 'not_on_allow_list' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('refuses an unknown number and a number past checkout + 7 days', async () => {
    expect((await sendStayWhatsApp(db as any, { ...base, phone: '919999999999', stayId: 's1', now: ist('2026-11-05 11:00'), transport: transport as any })).outcome).toBe('blocked')
    expect((await sendStayWhatsApp(db as any, { ...base, stayId: 's1', now: ist('2026-11-25 11:00'), transport: transport as any })).outcome).toBe('blocked')
    expect(transport).not.toHaveBeenCalled()
  })
})
