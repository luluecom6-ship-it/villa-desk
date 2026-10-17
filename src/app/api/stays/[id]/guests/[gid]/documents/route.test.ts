import { describe, it, expect, vi, beforeEach } from 'vitest'

const STAY = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  role: 'agent' as 'agent' | 'viewer',
  guestFound: true,
  rpcFails: false,
  removed: [] as string[],
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

vi.mock('@/lib/auth/account', () => {
  class Forbidden extends Error {
    status = 403
  }
  return {
    requireRole: async () => {
      h.calls.push('requireRole')
      if (h.role === 'viewer') throw new Forbidden('no')
      return {
        accountId: 'acc-1',
        userId: 'user-1',
        role: h.role,
        supabase: {
          from: () => {
            const q: Record<string, unknown> = {}
            for (const m of ['select', 'eq']) q[m] = () => q
            q.maybeSingle = async () => ({ data: h.guestFound ? { id: GUEST } : null })
            return q
          },
        },
      }
    },
    toErrorResponse: (err: { status?: number }) => ({ body: {}, status: err.status ?? 500 }),
  }
})

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: async () => {
          h.calls.push('upload')
          return { error: null }
        },
        remove: async (paths: string[]) => {
          h.calls.push('remove')
          h.removed.push(...paths)
          return { error: null }
        },
      }),
    },
    rpc: async (name: string) => {
      h.calls.push(`rpc:${name}`)
      return h.rpcFails ? { data: null, error: { message: 'stay_doc:bad_guest', code: 'P0001' } } : { data: 'doc-1', error: null }
    },
  }),
}))

import { POST } from './route'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])

function req(opts: { side?: string; bytes?: Uint8Array | null } = {}) {
  const fd = new FormData()
  fd.set('side', opts.side ?? 'front')
  if (opts.bytes !== null) fd.set('file', new File([(opts.bytes ?? JPEG) as BlobPart], 'x.jpg', { type: 'image/jpeg' }))
  return new Request('http://x', { method: 'POST', body: fd })
}
const call = (r: Request, id = STAY, gid = GUEST) =>
  POST(r, { params: Promise.resolve({ id, gid }) }) as unknown as Promise<{ body: Record<string, unknown>; status: number }>

beforeEach(() => {
  h.calls = []
  h.removed = []
  h.role = 'agent'
  h.guestFound = true
  h.rpcFails = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/stays/[id]/guests/[gid]/documents', () => {
  it('lets a caretaker upload: stored first, then recorded in one database call', async () => {
    const res = await call(req())
    expect(res.status).toBe(201)
    expect(h.calls).toEqual(['requireRole', 'upload', 'rpc:staff_attach_document'])
  })

  it('refuses a viewer before reading the body', async () => {
    h.role = 'viewer'
    const res = await call(req())
    expect(res.status).toBe(403)
    expect(h.calls).toEqual(['requireRole'])
  })

  it('rejects a file that is not an image or PDF by its content, storing nothing', async () => {
    const res = await call(req({ bytes: new TextEncoder().encode('<html>not an id</html>') }))
    expect(res.status).toBe(400)
    expect(h.calls).toEqual(['requireRole'])
  })

  it('rejects a bad side and a missing file', async () => {
    expect((await call(req({ side: 'top' }))).status).toBe(400)
    expect((await call(req({ bytes: null }))).status).toBe(400)
    expect(h.calls.filter((c) => c === 'upload')).toHaveLength(0)
  })

  it('404s for a guest outside this stay and account, storing nothing', async () => {
    h.guestFound = false
    const res = await call(req())
    expect(res.status).toBe(404)
    expect(h.calls).toEqual(['requireRole'])
  })

  it('removes only its own just-uploaded file when recording fails', async () => {
    h.rpcFails = true
    const res = await call(req())
    expect(res.status).toBe(500)
    expect(h.calls).toEqual(['requireRole', 'upload', 'rpc:staff_attach_document', 'remove'])
    expect(h.removed).toHaveLength(1)
  })
})
