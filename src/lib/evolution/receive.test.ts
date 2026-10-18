/* eslint-disable @typescript-eslint/no-explicit-any -- mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '@/lib/stays/messaging/test-support'

const m = vi.hoisted(() => ({ stay: vi.fn() }))
vi.mock('@/lib/stays/messaging/inbound', () => ({ handleStayInbound: m.stay }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ conversationId: 'conv-1', contactId: 'c-1' }) }))

import { receiveUpsert } from './receive'

const msg = (over: any = {}) => ({
  key: { id: 'M1', remoteJid: '919876543210@s.whatsapp.net', fromMe: false },
  pushName: 'Asha',
  message: { conversation: 'READY' },
  messageTimestamp: 1_800_000_000,
  ...over,
})
const ctx = () => {
  const db = new FakeDb() as any
  db.rpc = vi.fn(async () => ({ error: null }))
  return { db, accountId: 'a', requestUrl: 'https://x.test' }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.stay.mockResolvedValue({ registered: true, handled: true, suppressAutomation: false })
})

describe('Evolution inbound', () => {
  it('a guest message is stored and handed to the stay logic with the exact digits', async () => {
    const c = ctx()
    const out = await receiveUpsert(msg(), c)
    expect(out).toBe('stay_command')
    expect(m.stay).toHaveBeenCalledWith(c.db, expect.objectContaining({ accountId: 'a', phone: '919876543210', text: 'READY' }))
    expect(c.db.tables.messages[0]).toMatchObject({ sender_type: 'customer', content_text: 'READY', message_id: 'M1' })
    expect(c.db.rpc).toHaveBeenCalledWith('bump_conversation_on_inbound', expect.objectContaining({ p_conversation_id: 'conv-1' }))
  })

  it('an unregistered number is silenced while villa mode is on', async () => {
    m.stay.mockResolvedValue({ registered: false, handled: false, suppressAutomation: true })
    expect(await receiveUpsert(msg(), ctx())).toBe('unregistered_silenced')
  })

  it('groups, status posts and messages without a phone number are ignored', async () => {
    const c = ctx()
    expect(await receiveUpsert(msg({ key: { id: 'G1', remoteJid: '1203@g.us', fromMe: false } }), c)).toBe('ignored')
    expect(await receiveUpsert(msg({ key: { id: 'L1', remoteJid: '55@lid', fromMe: false } }), c)).toBe('ignored_no_phone')
    expect(m.stay).not.toHaveBeenCalled()
  })

  it('a failure in the stay logic never throws and is reported', async () => {
    m.stay.mockRejectedValue(new Error('boom'))
    expect(await receiveUpsert(msg(), ctx())).toBe('stay_logic_error')
  })
})
