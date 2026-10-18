/* eslint-disable @typescript-eslint/no-explicit-any -- mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ mirror: vi.fn(), base64: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: m.mirror, normalizeMimeType: (v?: string | null) => (v ? v.split(';')[0].trim().toLowerCase() : null) }))
vi.mock('./client', () => ({ getBase64FromMedia: m.base64 }))
vi.mock('./server', () => ({ loadEvolutionConfig: async () => ({ account_id: 'a' }), connFromRow: () => ({}) }))

import { hasMediaType, kindForMime, storeEvolutionMedia } from './media'

const note = (over: any = {}): any => ({ kind: 'message', id: 'ABC123', type: 'image', text: null, timestamp: '1760000000', media: { mimetype: 'image/jpeg', fileName: null, base64: Buffer.from('hello').toString('base64') }, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  m.mirror.mockResolvedValue('https://cdn.test/a.jpg')
})

describe('incoming media', () => {
  it('knows which message types carry media and how to file them', () => {
    expect(hasMediaType('image')).toBe(true)
    expect(hasMediaType('audio')).toBe(true)
    expect(hasMediaType('text')).toBe(false)
    expect(kindForMime('audio/ogg')).toBe('audio')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('application/pdf')).toBe('document')
    expect(kindForMime(null)).toBe('document')
  })

  it('stores media that came inside the webhook', async () => {
    const r = await storeEvolutionMedia({} as any, {} as any, 'a', note())
    expect(r).toEqual({ url: 'https://cdn.test/a.jpg', mime: 'image/jpeg' })
    expect(m.base64).not.toHaveBeenCalled()
    expect(m.mirror.mock.calls[0][0]).toMatchObject({ accountId: 'a', mediaId: 'ABC123', mimeType: 'image/jpeg', fileSize: 5 })
  })

  it('asks Evolution for the file when the webhook did not carry it', async () => {
    m.base64.mockResolvedValue({ base64: 'data:audio/ogg;base64,' + Buffer.from('voice').toString('base64'), mimetype: 'audio/ogg; codecs=opus', fileName: null })
    const r = await storeEvolutionMedia({} as any, {} as any, 'a', note({ type: 'audio', media: { mimetype: null, fileName: null, base64: null } }))
    expect(m.base64).toHaveBeenCalled()
    expect(m.mirror.mock.calls[0][0].fileSize).toBe(5)
    expect(r.mime).toBe('audio/ogg')
  })

  it('returns nothing (the message still arrives) when the file cannot be fetched', async () => {
    m.base64.mockRejectedValue(new Error('gone'))
    const r = await storeEvolutionMedia({} as any, {} as any, 'a', note({ media: { mimetype: 'image/png', fileName: null, base64: null } }))
    expect(r).toEqual({ url: null, mime: 'image/png' })
    expect(m.mirror).not.toHaveBeenCalled()
  })
})
