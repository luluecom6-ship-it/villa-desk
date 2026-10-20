/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db + mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../messaging/test-support'

const m = vi.hoisted(() => ({
  sendMedia: vi.fn(),
  sendAudio: vi.fn(),
  sendText: vi.fn(),
  sendReaction: vi.fn(),
  sendMessage: vi.fn(),
}))
vi.mock('@/lib/evolution/server', () => ({ loadEvolutionConfig: async () => ({ account_id: 'a', state: 'open' }), connFromRow: () => ({}) }))
vi.mock('@/lib/evolution/safety-server', () => ({ sendGate: async () => null, recordSend: async () => undefined }))
vi.mock('@/lib/evolution/client', () => ({ sendText: m.sendText, sendMedia: m.sendMedia, sendAudio: m.sendAudio, sendReaction: m.sendReaction, userJid: (n: string) => `${n}@s.whatsapp.net` }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: m.sendMessage }))

import { findRelayAgent, forwardToResponder, onAgentMessage } from './server'
import { openEscalation, runEscalations } from '../escalation/server'

let db: any
const T0 = new Date('2026-11-01T10:00:00Z')
const sentTo = (phone: string) => m.sendText.mock.calls.filter((c) => c[1] === phone).map((c) => c[2] as string)

beforeEach(() => {
  vi.clearAllMocks()
  let n = 0
  m.sendText.mockImplementation(async () => ({ id: `FWD${++n}` }))
  m.sendMedia.mockResolvedValue({ id: 'FWDM' })
  m.sendAudio.mockResolvedValue({ id: 'FWDA' })
  m.sendReaction.mockResolvedValue(undefined)
  m.sendMessage.mockResolvedValue({ messageId: 'x', whatsappMessageId: 'y' })
  db = new FakeDb()
  db.tables.profiles = [
    { user_id: 'owner', account_id: 'a', account_role: 'owner', created_at: '1', available: true, alert_phone: '966500000001', full_name: 'Owner Om' },
    { user_id: 'care1', account_id: 'a', account_role: 'agent', created_at: '2', available: true, alert_phone: '966500000002', full_name: 'Ravi' },
    { user_id: 'care2', account_id: 'a', account_role: 'agent', created_at: '3', available: true, alert_phone: '966500000003', full_name: 'Sara' },
  ]
  db.tables.properties = [{ account_id: 'a', escalate_after_minutes: 10 }]
  db.tables.contacts = []
  db.tables.conversations = [{ id: 'c1', account_id: 'a', relay_code: 482, contact: { name: 'Asha Rao', phone: '+919876543210' } }]
  db.tables.stays = [{ id: 's1', account_id: 'a', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919876543210', checkin_at: '2026-11-12T08:30:00Z', checkout_at: '2026-11-14T05:30:00Z', created_at: '1' }]
})

const open = (text = 'Is parking free?', messageId = 'G1') =>
  openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha (MS-2026-001)', preview: text, messageId, siteUrl: 'https://x.test', now: T0 })

describe('guest message -> the agent\'s own WhatsApp', () => {
  it('the first agent gets the guest\'s message with the chat number, masked guest number and stay', async () => {
    await open()
    const got = sentTo('966500000002')
    expect(got).toHaveLength(1)
    expect(got[0]).toContain('#482')
    expect(got[0]).toContain('Is parking free?')
    expect(got[0]).toContain('MS-2026-001')
    expect(got[0]).not.toContain('919876543210')
    expect(sentTo('966500000003')).toHaveLength(0)
    expect(db.tables.relay_forwards[0]).toMatchObject({ conversation_id: 'c1', user_id: 'care1', forward_message_id: 'FWD1', source_message_id: 'G1' })
  })

  it('a second message while the chat is open follows to the same agent, once', async () => {
    await open()
    await open('Hello?', 'G2')
    await open('Hello?', 'G2') // a replayed delivery
    const got = sentTo('966500000002')
    expect(got).toHaveLength(2)
    expect(got[1]).toBe('*#482 Asha Rao:* “Hello?”')
  })

  it('no reply in time: the next agent gets the unanswered messages and the first is told', async () => {
    db.tables.messages = [{ id: 'm1', conversation_id: 'c1', sender_type: 'customer', message_id: 'G1', content_text: 'Is parking free?', created_at: T0.toISOString() }]
    await open()
    await runEscalations(db, 'https://x.test', new Date(T0.getTime() + 11 * 60_000))
    const second = sentTo('966500000003')
    expect(second).toHaveLength(1)
    expect(second[0]).toContain('Moved from Ravi')
    expect(second[0]).toContain('Is parking free?')
    expect(sentTo('966500000002').some((t) => t.includes('moved to Sara'))).toBe(true)
  })

  it('the agent who answered last time gets the guest\'s next message first', async () => {
    db.tables.relay_forwards = [{ id: 1, account_id: 'a', conversation_id: 'c1', user_id: 'care2', created_at: '2026-10-30T00:00:00Z' }]
    await open()
    expect(sentTo('966500000003')).toHaveLength(1)
    expect(sentTo('966500000002')).toHaveLength(0)
  })
})

describe('agent\'s WhatsApp -> the guest', () => {
  const agent = async (phone = '966500000002') => (await findRelayAgent(db, 'a', phone))!

  it('recognises team numbers only', async () => {
    expect((await findRelayAgent(db, 'a', '966500000002'))?.userId).toBe('care1')
    expect(await findRelayAgent(db, 'a', '919876543210')).toBeNull()
  })

  it('a swipe-reply goes to the guest from the villa number', async () => {
    await open()
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: 'https://x.test', msg: { id: 'AG1', text: 'Yes, parking is free', quotedId: 'FWD1', hasMedia: false } })
    expect(r).toBe('agent_reply_sent')
    expect(m.sendMessage).toHaveBeenCalledWith(db, 'a', { conversationId: 'c1', messageType: 'text', contentText: 'Yes, parking is free' })
    expect(m.sendReaction).toHaveBeenCalled()
  })

  it('"#482 text" works without swiping', async () => {
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'AG2', text: '#482 On my way', quotedId: null, hasMedia: false } })
    expect(r).toBe('agent_reply_sent')
    expect(m.sendMessage.mock.calls[0][2].contentText).toBe('On my way')
  })

  it('plain text goes to the agent\'s only open chat', async () => {
    await open()
    expect(await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'AG3', text: 'Coming', quotedId: null, hasMedia: false } })).toBe('agent_reply_sent')
  })

  it('a reply that cannot be matched is NOT sent and the agent is asked', async () => {
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'AG4', text: 'Hello', quotedId: null, hasMedia: false } })
    expect(r).toBe('agent_no_target')
    expect(m.sendMessage).not.toHaveBeenCalled()
    expect(sentTo('966500000002')[0]).toContain('Which guest')
  })

  it('a failed delivery is reported back to the agent', async () => {
    m.sendMessage.mockRejectedValue(new Error('Evolution is paused'))
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'AG5', text: '#482 hi', quotedId: null, hasMedia: false } })
    expect(r).toBe('agent_reply_failed')
    expect(sentTo('966500000002')[0]).toContain('Not delivered')
  })

  it('/off and /on change duty; /close ends the chase', async () => {
    await open()
    await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'C1', text: '/off', quotedId: null, hasMedia: false } })
    expect(db.tables.profiles.find((p: any) => p.user_id === 'care1').available).toBe(false)
    await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'C2', text: '/close #482', quotedId: null, hasMedia: false } })
    expect(db.tables.conversation_escalations[0].status).toBe('resolved')
  })

  it('/transfer gives the chat to another person with the waiting messages', async () => {
    db.tables.messages = [{ id: 'm1', conversation_id: 'c1', sender_type: 'customer', message_id: 'G1', content_text: 'Is parking free?', created_at: T0.toISOString() }]
    await open()
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'T1', text: '/transfer Sara', quotedId: null, hasMedia: false } })
    expect(r).toBe('agent_transfer')
    expect(sentTo('966500000003')[0]).toContain('Is parking free?')
    expect(db.tables.conversation_escalations[0].notified_user_ids.at(-1)).toBe('care2')
  })

  it('a photo from the agent goes to the guest with their caption', async () => {
    await open()
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'P1', text: 'Here is the parking map', quotedId: 'FWD1', hasMedia: true, mediaUrl: 'https://cdn.test/map.jpg', mediaType: 'image/jpeg' } })
    expect(r).toBe('agent_reply_sent')
    expect(m.sendMessage).toHaveBeenCalledWith(db, 'a', { conversationId: 'c1', messageType: 'image', contentText: 'Here is the parking map', mediaUrl: 'https://cdn.test/map.jpg' })
  })

  it('a voice note from the agent goes as audio', async () => {
    await open()
    await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'V1', text: null, quotedId: 'FWD1', hasMedia: true, mediaUrl: 'https://cdn.test/v.ogg', mediaType: 'audio/ogg' } })
    expect(m.sendMessage.mock.calls[0][2]).toMatchObject({ messageType: 'audio', mediaUrl: 'https://cdn.test/v.ogg', contentText: null })
  })

  it('media that could not be downloaded is not sent and the agent is told', async () => {
    await open()
    const r = await onAgentMessage(db, { accountId: 'a', agent: await agent(), siteUrl: '', msg: { id: 'P2', text: null, quotedId: 'FWD1', hasMedia: true, mediaUrl: null, mediaType: null } })
    expect(r).toBe('agent_media_failed')
    expect(m.sendMessage).not.toHaveBeenCalled()
  })
})

describe('guest media -> the agent', () => {
  const openMedia = (messageId: string, mediaUrl: string, mediaType: string, text: string | null = '') =>
    openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha', preview: text ?? '', messageId, mediaUrl, mediaType, siteUrl: 'https://x.test', now: T0 })

  it('a guest photo reaches the agent as a photo with the chat details as the caption', async () => {
    await openMedia('M1', 'https://cdn.test/leak.jpg', 'image/jpeg', 'Water is leaking')
    expect(m.sendMedia).toHaveBeenCalledTimes(1)
    const [, to, opts] = m.sendMedia.mock.calls[0]
    expect(to).toBe('966500000002')
    expect(opts).toMatchObject({ kind: 'image', url: 'https://cdn.test/leak.jpg' })
    expect(opts.caption).toContain('#482')
    expect(opts.caption).toContain('Water is leaking')
    expect(db.tables.relay_forwards[0]).toMatchObject({ forward_message_id: 'FWDM', source_message_id: 'M1' })
  })

  it('a guest voice note arrives as the chat details plus the audio', async () => {
    await openMedia('M2', 'https://cdn.test/v.ogg', 'audio/ogg')
    expect(sentTo('966500000002')[0]).toContain('[audio]')
    expect(m.sendAudio).toHaveBeenCalledTimes(1)
  })

  it('media that was not stored still reaches the agent as a note', async () => {
    await openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha', preview: '', messageId: 'M3', siteUrl: '', now: T0 })
    expect(m.sendMedia).not.toHaveBeenCalled()
    expect(m.sendText).toHaveBeenCalled()
  })

  it('swiping-replying to a forwarded photo still finds the guest', async () => {
    await openMedia('M4', 'https://cdn.test/x.jpg', 'image/jpeg')
    const a = (await findRelayAgent(db, 'a', '966500000002'))!
    expect(await onAgentMessage(db, { accountId: 'a', agent: a, siteUrl: '', msg: { id: 'R1', text: 'Sending someone', quotedId: 'FWDM', hasMedia: false } })).toBe('agent_reply_sent')
  })
})

describe('forwarding', () => {
  it('does nothing for a person with no WhatsApp number', async () => {
    const n = await forwardToResponder(db, { accountId: 'a', conversationId: 'c1', to: { userId: 'x', role: 'agent', available: true, alertPhone: null, createdAt: '' }, items: [{ messageId: 'G1', text: 'hi' }], intro: true })
    expect(n).toBe(0)
  })
})

describe('an open chase held by someone without a WhatsApp number', () => {
  it('a new guest message is handed to the first person who has one, and the result is reported', async () => {
    db.tables.profiles[1].alert_phone = null // Ravi has no number
    db.tables.conversation_escalations = [{ id: 'e1', account_id: 'a', conversation_id: 'c1', status: 'open', notified_user_ids: ['care1'], opened_at: T0.toISOString(), due_at: new Date(T0.getTime() + 600000).toISOString() }]
    db.tables.messages = [{ id: 'm1', conversation_id: 'c1', sender_type: 'customer', message_id: 'G1', content_text: 'Hello?', created_at: T0.toISOString() }]
    const seen: string[] = []
    await openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha', preview: 'Hello?', messageId: 'G1', siteUrl: '', now: T0, report: (d) => seen.push(d) })
    expect(seen).toEqual(['rerouted:sent'])
    expect(sentTo('966500000003')).toHaveLength(1) // Sara, the next agent with a number
  })

  it('a new chase skips agents with no number and says when nobody has one', async () => {
    db.tables.profiles.forEach((p: any) => { p.alert_phone = null })
    const seen: string[] = []
    await openEscalation(db, { accountId: 'a', conversationId: 'c1', stayId: 's1', label: 'Asha', preview: 'Hi', messageId: 'G9', siteUrl: '', now: T0, report: (d) => seen.push(d) })
    expect(seen).toEqual(['opened:no_number'])
    expect(m.sendText).not.toHaveBeenCalled()
  })
})

describe('context for the agent', () => {
  it('a chat the agent just received includes the last few messages, so the app need not be opened', async () => {
    db.tables.messages = [
      { id: 'm0', conversation_id: 'c1', sender_type: 'customer', message_id: 'G0', content_text: 'What time is check-in?', created_at: '2026-11-01T09:00:00Z' },
      { id: 'm1', conversation_id: 'c1', sender_type: 'agent', message_id: 'A0', content_text: 'From 2 pm.', created_at: '2026-11-01T09:05:00Z' },
      { id: 'm2', conversation_id: 'c1', sender_type: 'customer', message_id: 'G1', content_text: 'Can we come at noon?', created_at: T0.toISOString() },
    ]
    await open('Can we come at noon?', 'G1')
    const text = sentTo('966500000002')[0]
    expect(text).toContain('Earlier:')
    expect(text).toContain('Guest: What time is check-in?')
    expect(text).toContain('Us: From 2 pm.')
    expect(text).toContain('“Can we come at noon?”')
    expect(text.match(/Can we come at noon/g)).toHaveLength(1) // the new message is not repeated as history
  })
})

describe('an agent who cannot be reached on WhatsApp', () => {
  it('the owner gets a bell saying why, once', async () => {
    m.sendText.mockRejectedValue(new Error('boom'))
    db.tables.notifications = []
    await open('Hello', 'G1')
    await open('Hello again', 'G2')
    const bells = db.tables.notifications.filter((n: any) => n.title.startsWith('Could not WhatsApp'))
    expect(bells.length).toBeGreaterThan(0)
    expect(new Set(bells.map((n: any) => n.user_id))).toEqual(new Set(['owner']))
    expect(bells.filter((n: any) => n.user_id === 'owner')).toHaveLength(1) // not repeated within 30 minutes
  })
})

describe('food order commands from the caretaker\'s WhatsApp', () => {
  it('/ok confirms the waiting order and /no needs a pending one', async () => {
    db.tables.food_orders = [{ id: 'o1', account_id: 'a', order_no: 12, stay_id: 's1', conversation_id: 'c1', items: [{ name: 'Idli', price: 100, qty: 2 }], total: 200, status: 'pending', created_at: '1' }]
    db.tables.stays[0].status = 'registered'
    const msg = (text: string) => ({ id: `A-${text}`, text, quotedId: null, hasMedia: false })
    const agent = (await findRelayAgent(db, 'a', '966500000002'))!
    const r1 = await onAgentMessage(db, { accountId: 'a', agent, msg: msg('/ok #482'), siteUrl: '' })
    expect(r1).toBe('agent_order_confirmed')
    expect(db.tables.food_orders[0]).toMatchObject({ status: 'confirmed', decided_by_name: 'Ravi' })
    expect(sentTo('966500000002').at(-1)).toContain('Order F12 confirmed')
    const r2 = await onAgentMessage(db, { accountId: 'a', agent, msg: msg('/no #482 closed'), siteUrl: '' })
    expect(r2).toBe('agent_order_none')
  })

  it('"confirm" with an order waiting confirms it instead of going to the guest', async () => {
    db.tables.food_orders = [{ id: 'o1', account_id: 'a', order_no: 12, stay_id: 's1', conversation_id: 'c1', items: [{ name: 'Idli', price: 100, qty: 2 }], total: 200, status: 'pending', created_at: '1' }]
    db.tables.stays[0].status = 'registered'
    const agent = (await findRelayAgent(db, 'a', '966500000002'))!
    const r = await onAgentMessage(db, { accountId: 'a', agent, msg: { id: 'A-ok2', text: '#482 confirm', quotedId: null, hasMedia: false }, siteUrl: '' })
    expect(r).toBe('agent_order_confirmed')
    expect(db.tables.food_orders[0].status).toBe('confirmed')
  })

  it('"ok" is just a message to the guest, even with an order waiting', async () => {
    db.tables.food_orders = [{ id: 'o1', account_id: 'a', order_no: 12, stay_id: 's1', conversation_id: 'c1', items: [{ name: 'Idli', price: 100, qty: 2 }], total: 200, status: 'pending', created_at: '1' }]
    db.tables.stays[0].status = 'registered'
    const agent = (await findRelayAgent(db, 'a', '966500000002'))!
    const r = await onAgentMessage(db, { accountId: 'a', agent, msg: { id: 'A-ok3', text: '#482 ok', quotedId: null, hasMedia: false }, siteUrl: '' })
    expect(r).not.toBe('agent_order_confirmed')
    expect(r).not.toBe('agent_order_none')
    expect(db.tables.food_orders[0].status).toBe('pending')
  })
})
