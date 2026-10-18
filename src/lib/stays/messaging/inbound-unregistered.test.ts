/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db + mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from './test-support'

const m = vi.hoisted(() => ({ sendText: vi.fn() }))
vi.mock('@/lib/evolution/server', () => ({ loadEvolutionConfig: async () => ({ account_id: 'a', state: 'open' }), connFromRow: () => ({}) }))
vi.mock('@/lib/evolution/safety-server', () => ({ sendGate: async () => null, recordSend: async () => undefined }))
vi.mock('@/lib/evolution/client', () => ({ sendText: m.sendText, sendMedia: vi.fn(), sendAudio: vi.fn(), sendReaction: vi.fn(), connectionState: vi.fn(), userJid: (n: string) => n }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))

import { handleStayInbound } from './inbound'

describe('a message from a number that is not on a stay', () => {
  let db: any
  beforeEach(() => {
    vi.clearAllMocks()
    m.sendText.mockResolvedValue({ id: 'FWD1' })
    db = new FakeDb()
    db.tables.profiles = [{ user_id: 'care1', account_id: 'a', account_role: 'agent', created_at: '1', available: true, alert_phone: '966500000002', full_name: 'Ravi' }]
    db.tables.properties = [{ account_id: 'a', villa_mode: false, escalate_after_minutes: 10 }]
    db.tables.conversations = [{ id: 'c1', account_id: 'a', relay_code: 7, contact: { name: 'Someone', phone: '+966511111111' } }]
    db.tables.stays = []
  })

  it('still reaches the agent when villa mode is off', async () => {
    await handleStayInbound(db, { accountId: 'a', phone: '966511111111', text: 'Hello, is the villa free?', requestUrl: 'https://x.test', conversationId: 'c1', messageId: 'G1', now: new Date('2026-11-01T10:00:00Z') })
    const sent = m.sendText.mock.calls.filter((c) => c[1] === '966500000002')
    expect(sent).toHaveLength(1)
    expect(sent[0][2]).toContain('Hello, is the villa free?')
  })
})
