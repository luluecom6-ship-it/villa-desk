/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../messaging/test-support'
import { buildChain, decide, nextResponder, type Responder } from './plan'

vi.mock('@/lib/evolution/server', () => ({ loadEvolutionConfig: async () => null, connFromRow: () => ({}) }))
vi.mock('@/lib/evolution/safety-server', () => ({ sendGate: async () => null, recordSend: async () => undefined }))
vi.mock('@/lib/evolution/client', () => ({ sendText: vi.fn() }))

import { openEscalation, runEscalations } from './server'

const R = (userId: string, role: string, over: Partial<Responder> = {}): Responder => ({ userId, role, available: true, alertPhone: null, createdAt: userId, ...over })

describe('who is told, in what order', () => {
  it('available agents first, then the owner', () => {
    const chain = buildChain([R('o1', 'owner'), R('c2', 'agent'), R('c1', 'agent'), R('v', 'viewer')])
    expect(chain.map((m) => m.userId)).toEqual(['c1', 'c2', 'o1'])
  })
  it('an agent who is off duty is skipped; with no agent left it goes to the owner', () => {
    const chain = buildChain([R('o1', 'owner'), R('c1', 'agent', { available: false })])
    expect(chain.map((m) => m.userId)).toEqual(['o1'])
  })
  it('admins are the fallback only when there is no owner', () => {
    expect(buildChain([R('a1', 'admin'), R('o1', 'owner')]).map((m) => m.userId)).toEqual(['o1'])
    expect(buildChain([R('a1', 'admin')]).map((m) => m.userId)).toEqual(['a1'])
  })
  it('next = first not yet told', () => {
    const chain = buildChain([R('c1', 'agent'), R('c2', 'agent'), R('o1', 'owner')])
    expect(nextResponder(chain, ['c1'])?.userId).toBe('c2')
    expect(nextResponder(chain, ['c1', 'c2', 'o1'])).toBeNull()
  })
  it('decisions', () => {
    const chain = buildChain([R('c1', 'agent'), R('o1', 'owner')])
    const t = new Date('2026-11-01T10:00:00Z')
    const later = new Date(t.getTime() + 11 * 60_000)
    expect(decide({ replied: true, dueAt: t, now: later, chain, notified: ['c1'] })).toBe('resolve_replied')
    expect(decide({ replied: false, dueAt: later, now: t, chain, notified: ['c1'] })).toBe('wait')
    expect(decide({ replied: false, dueAt: t, now: later, chain, notified: ['c1'] })).toBe('advance')
    expect(decide({ replied: false, dueAt: t, now: later, chain, notified: ['c1', 'o1'] })).toBe('exhausted')
  })
})

describe('chasing a guest message', () => {
  let db: any
  const T0 = new Date('2026-11-01T10:00:00Z')
  const at = (min: number) => new Date(T0.getTime() + min * 60_000)
  const bells = () => (db.tables.notifications ?? []).map((n: any) => n.user_id)

  beforeEach(() => {
    db = new FakeDb()
    db.tables.profiles = [
      { user_id: 'owner', account_id: 'a', account_role: 'owner', created_at: '1', available: true },
      { user_id: 'care1', account_id: 'a', account_role: 'agent', created_at: '2', available: true },
      { user_id: 'care2', account_id: 'a', account_role: 'agent', created_at: '3', available: true },
    ]
    db.tables.properties = [{ account_id: 'a', escalate_after_minutes: 10 }]
    db.tables.stays = [{ id: 's1', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao' }]
  })
  const open = () => openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha (MS-2026-001)', preview: 'Is parking free?', siteUrl: 'https://x.test', now: T0 })

  it('the first agent is told at once, nobody else', async () => {
    expect(await open()).toBe('opened')
    expect(bells()).toEqual(['care1'])
    expect(db.tables.notifications[0].title).toContain('Asha')
  })

  it('a second message while open does not start another chase', async () => {
    await open()
    db.tables.conversation_escalations[0].status = 'open'
    expect(await open()).toBe('already_open')
    expect(bells()).toEqual(['care1'])
  })

  it('no reply: after 10 minutes the next agent, then the owner, then it ends', async () => {
    await open()
    await runEscalations(db, 'https://x.test', at(5))
    expect(bells()).toEqual(['care1'])
    await runEscalations(db, 'https://x.test', at(11))
    expect(bells()).toEqual(['care1', 'care2'])
    expect(db.tables.notifications[1].title).toMatch(/^Not answered yet/)
    await runEscalations(db, 'https://x.test', at(22))
    expect(bells()).toEqual(['care1', 'care2', 'owner'])
    const s = await runEscalations(db, 'https://x.test', at(33))
    expect(s.exhausted).toBe(1)
    expect(db.tables.conversation_escalations[0]).toMatchObject({ status: 'resolved', resolved_reason: 'unanswered' })
  })

  it('a person replying stops the chase', async () => {
    await open()
    db.tables.messages = [{ conversation_id: 'c1', sender_type: 'agent', created_at: at(3).toISOString() }]
    const s = await runEscalations(db, 'https://x.test', at(11))
    expect(s.replied).toBe(1)
    expect(bells()).toEqual(['care1'])
    expect(db.tables.conversation_escalations[0].resolved_reason).toBe('replied')
  })

  it('an automatic (bot) message is not a reply', async () => {
    await open()
    db.tables.messages = [{ conversation_id: 'c1', sender_type: 'bot', created_at: at(3).toISOString() }]
    await runEscalations(db, 'https://x.test', at(11))
    expect(bells()).toEqual(['care1', 'care2'])
  })

  it('with no agent available the owner is told first', async () => {
    db.tables.profiles.forEach((p: any) => { if (p.account_role === 'agent') p.available = false })
    await open()
    expect(bells()).toEqual(['owner'])
  })
})
