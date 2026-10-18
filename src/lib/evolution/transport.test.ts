/* eslint-disable @typescript-eslint/no-explicit-any -- mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '@/lib/stays/messaging/test-support'
import { StayWaitError, sendStayWhatsApp } from '@/lib/stays/messaging/send'

const m = vi.hoisted(() => ({
  cfg: null as any,
  gate: null as any,
  sendText: vi.fn(),
  recordSend: vi.fn(),
  pauseNumber: vi.fn(),
  checkHealth: vi.fn(),
  connectionState: vi.fn(),
}))

vi.mock('./server', () => ({ loadEvolutionConfig: async () => m.cfg, connFromRow: () => ({ baseUrl: 'x', instance: 'i', apiKey: 'k' }) }))
vi.mock('./safety-server', () => ({ sendGate: async () => m.gate, recordSend: m.recordSend, pauseNumber: m.pauseNumber, checkHealth: m.checkHealth }))
vi.mock('./client', async () => {
  class EvolutionError extends Error { constructor(msg: string, public status: number) { super(msg) } }
  return { EvolutionError, sendText: m.sendText, sendMedia: vi.fn(), sendAudio: vi.fn(), connectionState: m.connectionState }
})
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: async () => ({ conversationId: 'conv-1', contactId: 'c-1' }) }))

import { EvolutionError } from './client'
import { evolutionStayTransport } from './transport'

const args = (kind: 'scheduled' | 'reply') => ({ db: new FakeDb() as any, accountId: 'a', phone: '919876543210', guestName: 'Asha', text: 'hello', kind })

beforeEach(() => {
  vi.clearAllMocks()
  m.cfg = { account_id: 'a', state: 'open', paused_at: null }
  m.gate = null
  m.pauseNumber.mockResolvedValue(undefined)
  m.checkHealth.mockResolvedValue(false)
  m.recordSend.mockResolvedValue(undefined)
})

describe('Evolution transport for stay messages', () => {
  it('sends plain text, records the send and stores the message', async () => {
    m.sendText.mockResolvedValue({ id: 'WA1' })
    const a = args('reply')
    const r = await evolutionStayTransport(a)
    expect(r.messageId).toBe('WA1')
    expect(m.sendText).toHaveBeenCalledWith(expect.anything(), '919876543210', 'hello', { delayMs: undefined })
    expect(m.recordSend).toHaveBeenCalledWith('a', { ok: true, kind: 'reply', phone: '919876543210' }, a.db)
    expect((a.db as FakeDb).tables.messages[0]).toMatchObject({ conversation_id: 'conv-1', message_id: 'WA1', sender_type: 'bot' })
  })

  it('scheduled sends get a short human-like pause', async () => {
    m.sendText.mockResolvedValue({ id: 'WA2' })
    await evolutionStayTransport(args('scheduled'))
    expect(m.sendText.mock.calls[0][3].delayMs).toBeGreaterThanOrEqual(1500)
  })

  it.each(['paused', 'outside_hours', 'daily_limit', 'disconnected'])('%s means wait, not fail', async (code) => {
    m.gate = { code }
    await expect(evolutionStayTransport(args('scheduled'))).rejects.toBeInstanceOf(StayWaitError)
    expect(m.sendText).not.toHaveBeenCalled()
  })

  it('a number that was never linked fails with a clear code (no silent fallback to Meta)', async () => {
    m.cfg = null
    await expect(evolutionStayTransport(args('reply'))).rejects.toMatchObject({ code: 'evolution_not_configured' })
  })

  it('401 from the server pauses the number immediately', async () => {
    m.sendText.mockRejectedValue(new EvolutionError('no', 401))
    await expect(evolutionStayTransport(args('scheduled'))).rejects.toMatchObject({ code: 'evolution_401' })
    expect(m.pauseNumber).toHaveBeenCalledWith('a', 'logged_out', expect.anything())
    expect(m.recordSend).toHaveBeenCalledWith('a', expect.objectContaining({ ok: false, errorCode: 'evolution_401' }), expect.anything())
  })

  it('other failures run the health check', async () => {
    m.sendText.mockRejectedValue(new EvolutionError('boom', 500))
    await expect(evolutionStayTransport(args('scheduled'))).rejects.toMatchObject({ code: 'evolution_500' })
    expect(m.checkHealth).toHaveBeenCalled()
    expect(m.pauseNumber).not.toHaveBeenCalled()
  })
})

describe('sendStayWhatsApp with a waiting transport', () => {
  it('returns waiting and logs no failure', async () => {
    const db = new FakeDb() as any
    db.tables.stays = [{ id: 's1', account_id: 'a', guest_phone: '919876543210', automation_ready: true, status: 'confirmed', checkout_at: new Date(Date.now() + 86_400_000).toISOString(), stay_ref: 'MS-1' }]
    const r = await sendStayWhatsApp(db, {
      accountId: 'a', stayId: 's1', phone: '919876543210', guestName: 'Asha', text: 'x', messageKey: 'form_link', enforceWindow: false,
      transport: async () => { throw new StayWaitError('paused') },
    })
    expect(r.outcome === 'waiting' || r.outcome === 'blocked').toBe(true)
    expect((db.tables.stay_message_log ?? []).some((l: any) => l.outcome === 'failed')).toBe(false)
  })
})
