/* eslint-disable @typescript-eslint/no-explicit-any -- mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  cfg: null as any,
  updates: [] as any[],
  pauseNumber: vi.fn(),
  logEvent: vi.fn(),
  receiveUpsert: vi.fn(),
  receiveUpdates: vi.fn(),
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
  after: (fn: () => Promise<void>) => { m.afterFns.push(fn) },
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.cfg }) }) }),
      update: (patch: any) => { m.updates.push(patch); return { eq: async () => ({}) } },
    }),
  }),
}))
vi.mock('@/lib/evolution/safety-server', () => ({ pauseNumber: m.pauseNumber }))
vi.mock('@/lib/evolution/receive', () => ({ receiveUpsert: m.receiveUpsert, receiveUpdates: m.receiveUpdates }))
vi.mock('@/lib/evolution/server', () => ({ logEvolutionEvent: m.logEvent }))

import { POST } from './route'

const SECRET = 'a'.repeat(48)
const call = (body: unknown, secret = SECRET) =>
  POST({ json: async () => body, url: 'https://x.test/api/evolution/webhook/' + secret } as any, { params: Promise.resolve({ secret }) }) as any

beforeEach(() => {
  vi.clearAllMocks()
  m.updates = []
  m.afterFns = []
  m.cfg = { account_id: 'acc', instance_name: 'villa', webhook_secret: SECRET }
})

describe('Evolution webhook', () => {
  it('answers 404 for a malformed or unknown secret', async () => {
    expect((await call({}, 'short')).status).toBe(404)
    m.cfg = null
    expect((await call({})).status).toBe(404)
  })

  it('ignores deliveries for another instance', async () => {
    const r = await call({ event: 'MESSAGES_UPSERT', instance: 'other', data: {} })
    expect(r.status).toBe(200)
    expect(m.afterFns).toHaveLength(0)
  })

  it('a close with status 401 marks the number logged out and pauses sending', async () => {
    await call({ event: 'CONNECTION_UPDATE', instance: 'villa', data: { state: 'close', statusReason: 401 } })
    expect(m.updates[0].state).toBe('logged_out')
    expect(m.pauseNumber).toHaveBeenCalledWith('acc', 'logged_out', expect.anything())
  })

  it('a close with status 403 pauses as refused by WhatsApp', async () => {
    await call({ event: 'CONNECTION_UPDATE', instance: 'villa', data: { state: 'close', statusReason: 403 } })
    expect(m.pauseNumber).toHaveBeenCalledWith('acc', 'refused_by_whatsapp', expect.anything())
  })

  it('an ordinary close does not pause (Baileys reconnects by itself)', async () => {
    await call({ event: 'CONNECTION_UPDATE', instance: 'villa', data: { state: 'close', statusReason: 428 } })
    expect(m.updates[0].state).toBe('close')
    expect(m.pauseNumber).not.toHaveBeenCalled()
  })

  it('open clears the QR and pairing code and stores the number', async () => {
    await call({ event: 'CONNECTION_UPDATE', instance: 'villa', data: { state: 'open', wuid: '919876543210@s.whatsapp.net' } })
    expect(m.updates[0]).toMatchObject({ state: 'open', qr_code: null, pairing_code: null, connected_number: '919876543210' })
  })

  it('stores a new QR code and pairing code', async () => {
    await call({ event: 'QRCODE_UPDATED', instance: 'villa', data: { qrcode: { base64: 'data:image/png;base64,AAA', pairingCode: 'ABCD1234' } } })
    expect(m.updates[0]).toMatchObject({ qr_code: 'data:image/png;base64,AAA', pairing_code: 'ABCD1234', state: 'connecting' })
  })

  it('guest messages are processed after the 200, and the log keeps only the outcome', async () => {
    m.receiveUpsert.mockResolvedValue('stay_command')
    const r = await call({ event: 'MESSAGES_UPSERT', instance: 'villa', data: { key: { id: '1' } } })
    expect(r.status).toBe(200)
    expect(m.receiveUpsert).not.toHaveBeenCalled()
    await m.afterFns[0]()
    expect(m.receiveUpsert).toHaveBeenCalledTimes(1)
    expect(m.logEvent).toHaveBeenCalledWith('acc', 'messages.upsert', 'stay_command', expect.anything())
    for (const c of m.logEvent.mock.calls) expect(JSON.stringify(c)).not.toContain('"key"')
  })
})
