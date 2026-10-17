import { describe, it, expect, vi, beforeEach } from 'vitest'

// The ID-image link route is the one door to the private bucket, so the order
// of its steps is the thing under test: role check first, then the access-log
// row, and only then a 60-second link. If the log write fails, no link exists.

const STAY = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  role: 'admin' as 'admin' | 'agent',
  logFails: false,
  signFails: false,
  docFound: true,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      body,
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
    }),
  },
}))

vi.mock('@/lib/auth/account', () => {
  class Forbidden extends Error {
    status = 403
  }
  return {
    requireRole: async () => {
      h.calls.push('requireRole')
      if (h.role !== 'admin') throw new Forbidden('no')
      return {
        accountId: 'acc-1',
        userId: 'user-1',
        role: 'admin',
        supabase: {
          from: () => {
            const q: Record<string, unknown> = {}
            for (const m of ['select', 'eq']) q[m] = () => q
            q.maybeSingle = async () => {
              h.calls.push('lookup')
              return {
                data: h.docFound
                  ? { id: DOC, stay_id: STAY, account_id: 'acc-1', storage_path: 'account-acc-1/s/d.jpg', content_type: 'image/jpeg', superseded_at: null }
                  : null,
              }
            }
            return q
          },
        },
      }
    },
    toErrorResponse: (err: { status?: number }) => ({ body: {}, status: err.status ?? 500, headers: {} }),
  }
})

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async () => {
        h.calls.push(`insert:${table}`)
        return { error: h.logFails ? { code: 'XX' } : null }
      },
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (_path: string, seconds: number) => {
          h.calls.push(`sign:${seconds}`)
          return h.signFails
            ? { data: null, error: { name: 'boom' } }
            : { data: { signedUrl: 'https://signed.example/x' }, error: null }
        },
      }),
    },
  }),
}))

import { POST } from './route'

const call = (id = STAY, did = DOC) =>
  POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ id, did }) }) as unknown as Promise<{
    body: Record<string, unknown>
    status: number
  }>

beforeEach(() => {
  h.calls = []
  h.role = 'admin'
  h.logFails = false
  h.signFails = false
  h.docFound = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/stays/[id]/documents/[did]/url', () => {
  it('logs the open first, then issues a 60-second link', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.body.url).toBe('https://signed.example/x')
    expect(res.body.expires_in).toBe(60)
    expect(h.calls).toEqual(['requireRole', 'lookup', 'insert:document_access_log', 'sign:60'])
  })

  it('refuses a caretaker before touching anything', async () => {
    h.role = 'agent'
    const res = await call()
    expect(res.status).toBe(403)
    expect(h.calls).toEqual(['requireRole'])
  })

  it('fails closed: no link when the access log cannot be written', async () => {
    h.logFails = true
    const res = await call()
    expect(res.status).toBe(503)
    expect(res.body.url).toBeUndefined()
    expect(h.calls.some((c) => c.startsWith('sign'))).toBe(false)
  })

  it('404s for a document that is not in this stay and account, logging nothing', async () => {
    h.docFound = false
    const res = await call()
    expect(res.status).toBe(404)
    expect(h.calls).toEqual(['requireRole', 'lookup'])
  })

  it('rejects malformed ids without a lookup', async () => {
    const res = await call('nope', DOC)
    expect(res.status).toBe(404)
    expect(h.calls).toEqual(['requireRole'])
  })

  it('returns an error, not a link, when signing fails', async () => {
    h.signFails = true
    const res = await call()
    expect(res.status).toBe(502)
    expect(res.body.url).toBeUndefined()
  })
})
