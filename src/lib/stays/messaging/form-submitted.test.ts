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
