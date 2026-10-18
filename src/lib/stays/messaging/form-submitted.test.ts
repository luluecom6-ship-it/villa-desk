/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { describe, expect, it, vi } from 'vitest'
import { FakeDb } from './test-support'

const wa = vi.hoisted(() => vi.fn())
vi.mock('../escalation/server', async () => {
  const actual = await vi.importActual<any>('../escalation/server')
  return { ...actual, whatsappTeamAlert: wa }
})
import { notifyFormSubmitted } from './form-submitted'

describe('form submitted alert', () => {
  it('rings the bell for the team and WhatsApps on-duty people with an alert number', async () => {
    const db = new FakeDb() as any
    db.tables.profiles = [
      { user_id: 'u1', account_id: 'a', account_role: 'owner', available: true, alert_phone: '966500000001', created_at: '2026-01-01' },
      { user_id: 'u2', account_id: 'a', account_role: 'agent', available: false, alert_phone: '966500000002', created_at: '2026-01-02' },
      { user_id: 'u3', account_id: 'a', account_role: 'agent', available: true, alert_phone: null, created_at: '2026-01-03' },
    ]
    await notifyFormSubmitted(db, { accountId: 'a', stayRef: 'MS-2026-001', guestName: 'Asha Rao', siteUrl: 'https://desk.test' })
    expect(db.tables.notifications.map((n: any) => n.user_id).sort()).toEqual(['u1', 'u2', 'u3'])
    expect(db.tables.notifications[0].title).toBe('Form submitted: MS-2026-001 (Asha)')
    expect(wa).toHaveBeenCalledTimes(1)
    expect(wa.mock.calls[0][2]).toBe('966500000001')
    expect(wa.mock.calls[0][3]).toContain('https://desk.test/stays')
  })
})

import { notifyStayCreated } from './form-submitted'

describe('registration created alert', () => {
  it('tells everyone except the person who created it, bell and WhatsApp', async () => {
    wa.mockClear()
    const db = new FakeDb() as any
    db.tables.profiles = [
      { user_id: 'owner', account_id: 'a', account_role: 'owner', available: true, alert_phone: '966500000001', created_at: '1' },
      { user_id: 'care1', account_id: 'a', account_role: 'agent', available: true, alert_phone: '966500000002', created_at: '2' },
      { user_id: 'care2', account_id: 'a', account_role: 'agent', available: false, alert_phone: '966500000003', created_at: '3' },
    ]
    await notifyStayCreated(db, { accountId: 'a', stayRef: 'MS-2026-002', guestName: 'Ravi Kumar', checkin: '2026-11-12T08:30:00Z', formSent: true, createdBy: 'owner', siteUrl: 'https://desk.test' })
    expect(db.tables.notifications.map((n: any) => n.user_id).sort()).toEqual(['care1', 'care2'])
    expect(db.tables.notifications[0].title).toBe('New registration: MS-2026-002 (Ravi)')
    expect(wa).toHaveBeenCalledTimes(1) // care2 is off duty
    expect(wa.mock.calls[0][2]).toBe('966500000002')
    expect(wa.mock.calls[0][3]).toContain('form link is being sent')
  })

  it('says when there is no mobile number yet', async () => {
    wa.mockClear()
    const db = new FakeDb() as any
    db.tables.profiles = [{ user_id: 'care1', account_id: 'a', account_role: 'agent', available: true, alert_phone: '966500000002', created_at: '2' }]
    await notifyStayCreated(db, { accountId: 'a', stayRef: 'MS-2026-003', guestName: null, checkin: null, formSent: false, createdBy: 'someone', siteUrl: 'https://d.test' })
    expect(db.tables.notifications[0].body).toContain('add it')
  })
})
