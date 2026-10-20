import { describe, expect, it } from 'vitest'
import { closeFinishedStays } from './server'

function mockDb(rows: unknown[] | null, error: unknown = null) {
  const calls: Array<[string, ...unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'in', 'lt', 'neq']) {
    chain[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return chain
    }
  }
  chain.select = async () => ({ data: rows, error })
  return { db: { from: () => chain } as never, calls }
}

describe('closeFinishedStays', () => {
  it('marks finished live stays checked out, only past check-out', async () => {
    const { db, calls } = mockDb([{ id: 'a' }])
    const now = new Date('2026-10-20T00:00:00Z')
    expect(await closeFinishedStays(db, 'acc', '966572657189', undefined, now)).toBe(1)
    expect(calls).toContainEqual(['update', { status: 'checked_out' }])
    expect(calls).toContainEqual(['in', 'status', ['registered', 'checked_in']])
    expect(calls).toContainEqual(['lt', 'checkout_at', now.toISOString()])
  })
  it('excludes the stay being edited and returns 0 on error', async () => {
    const { db, calls } = mockDb(null, { message: 'x' })
    expect(await closeFinishedStays(db, 'acc', '9665', 'me')).toBe(0)
    expect(calls).toContainEqual(['neq', 'id', 'me'])
  })
})
