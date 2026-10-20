/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { FakeDb } from '../messaging/test-support'
import { applyVerifyResults, archiveApproved, confirmCopy } from './server'

const SHA = 'ab'.repeat(32)
const mkDb = () => {
  const db = new FakeDb() as any
  db.tables.stay_documents = [{ id: 'd1', account_id: 'a', stay_id: 's1', size_bytes: 1000, sha256: SHA, drive_copied_at: null, drive_missing_at: null, archived_at: null }]
  db.tables.profiles = [{ user_id: 'u1', account_id: 'a', account_role: 'owner' }]
  return db
}

describe('confirmCopy', () => {
  it('records a Drive copy only when size and checksum match', async () => {
    const db = mkDb()
    expect(await confirmCopy(db, { id: 'd1', drive_file_id: 'F1', drive_url: 'https://drive/F1', size: 1000, sha256: SHA })).toEqual({ ok: true })
    expect(db.tables.stay_documents[0]).toMatchObject({ drive_file_id: 'F1', drive_checksum: SHA, drive_size_bytes: 1000 })
    expect(db.tables.stay_documents[0].drive_copied_at).toBeTruthy()
    expect(db.tables.document_archive_log.map((l: any) => l.action)).toEqual(['copied'])
  })
  it('a mismatch is refused, logged and alerted; nothing is recorded as backed up', async () => {
    const db = mkDb()
    expect(await confirmCopy(db, { id: 'd1', drive_file_id: 'F1', size: 999, sha256: SHA })).toEqual({ ok: false, error: 'mismatch' })
    expect(db.tables.stay_documents[0].drive_copied_at).toBeNull()
    expect(db.tables.document_archive_log[0].action).toBe('copy_failed')
    expect(db.tables.notifications.length).toBe(1)
  })
  it('unknown document and bad requests', async () => {
    const db = mkDb()
    expect(await confirmCopy(db, { id: 'nope', drive_file_id: 'F', size: 1, sha256: SHA })).toEqual({ ok: false, error: 'not_found' })
    expect(await confirmCopy(db, { id: 'd1' })).toEqual({ ok: false, error: 'bad_request' })
  })
})

describe('confirmCopy by Drive md5', () => {
  const bytes = Buffer.from('id-image-bytes')
  const md5 = createHash('md5').update(bytes).digest('hex')
  const mk = () => {
    const db = mkDb()
    db.tables.stay_documents[0].size_bytes = bytes.length
    db.tables.stay_documents[0].storage_path = 'p/d1'
    db.storage = { from: () => ({ download: async () => ({ data: new Blob([bytes]), error: null }) }) }
    return db
  }
  it('accepts a matching md5 and size, and records our sha256', async () => {
    const db = mk()
    expect(await confirmCopy(db, { id: 'd1', drive_file_id: 'F1', size: bytes.length, md5 })).toEqual({ ok: true })
    expect(db.tables.stay_documents[0].drive_checksum).toBe(SHA)
  })
  it('refuses a different md5 or size', async () => {
    const db = mk()
    expect(await confirmCopy(db, { id: 'd1', drive_file_id: 'F1', size: bytes.length, md5: '0'.repeat(32) })).toEqual({ ok: false, error: 'mismatch' })
    expect(await confirmCopy(db, { id: 'd1', drive_file_id: 'F1', size: bytes.length + 1, md5 })).toEqual({ ok: false, error: 'mismatch' })
    expect(db.tables.stay_documents[0].drive_copied_at).toBeNull()
  })
})

describe('weekly Drive check', () => {
  it('a missing archived file raises an urgent alert once and stays flagged', async () => {
    const db = mkDb()
    Object.assign(db.tables.stay_documents[0], { drive_file_id: 'F1', drive_copied_at: 'x', archived_at: 'y' })
    expect(await applyVerifyResults(db, [{ id: 'd1', exists: false }])).toEqual({ checked: 1, missing: 1 })
    expect(db.tables.stay_documents[0].drive_missing_at).toBeTruthy()
    expect(db.tables.notifications[0].title).toMatch(/URGENT/)
    await applyVerifyResults(db, [{ id: 'd1', exists: false }])
    expect(db.tables.notifications.length).toBe(1) // not repeated
  })
  it('a missing backup of a still-stored file is queued to be copied again', async () => {
    const db = mkDb()
    Object.assign(db.tables.stay_documents[0], { drive_file_id: 'F1', drive_copied_at: 'x' })
    await applyVerifyResults(db, [{ id: 'd1', exists: false }])
    expect(db.tables.stay_documents[0].drive_copied_at).toBeNull()
    expect(db.tables.stay_documents[0].drive_file_id).toBeNull()
  })
  it('a file that exists clears any earlier missing flag', async () => {
    const db = mkDb()
    Object.assign(db.tables.stay_documents[0], { drive_file_id: 'F1', drive_copied_at: 'x', drive_missing_at: 'z' })
    await applyVerifyResults(db, [{ id: 'd1', exists: true }])
    expect(db.tables.stay_documents[0].drive_missing_at).toBeNull()
  })
})

// A chain that answers every query with canned rows per table.
function canned(tables: Record<string, any[]>, rpcResult: any = true) {
  const removed: string[] = []
  const rpcCalls: any[] = []
  const chain = (rows: any[]) => {
    const c: any = {}
    for (const m of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order', 'gte', 'ilike', 'neq']) c[m] = () => c
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    c.insert = async () => ({ data: null, error: null })
    c.then = (a: any, b: any) => Promise.resolve({ data: rows, error: null }).then(a, b)
    return c
  }
  return {
    removed,
    rpcCalls,
    db: {
      from: (t: string) => chain(tables[t] ?? []),
      rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return { data: rpcResult, error: null } },
      storage: { from: () => ({ remove: async (p: string[]) => { removed.push(...p); return { error: null } } }) },
    } as any,
  }
}

describe('archiveApproved', () => {
  const old = new Date('2026-01-01T00:00:00Z').toISOString()
  const row = (id: string) => ({ id, size_bytes: 400_000_000, sha256: SHA, drive_checksum: SHA, drive_size_bytes: 400_000_000, drive_file_id: `F-${id}`, stay_id: 's', storage_path: `p/${id}`, stays: { stay_ref: 'MS-1', status: 'checked_out', checkout_at: old } })

  it('archives only ids on the recomputed proposal and removes the object after marking', async () => {
    const { db, rpcCalls, removed } = canned({ stay_documents: [row('d1'), row('d2')] })
    const r = await archiveApproved(db, { accountId: 'a', ids: ['d1', 'not-on-list'], actor: 'owner1', now: new Date('2026-10-20T00:00:00Z') })
    expect(r).toEqual({ archived: 1, skipped: 1, deleteFailed: 0 })
    expect(rpcCalls.map((c) => c[1].p_document_id)).toEqual(['d1'])
    expect(removed).toEqual(['p/d1'])
  })
  it('nothing is archived while usage is below 70%', async () => {
    const tiny = { ...row('d1'), size_bytes: 10, drive_size_bytes: 10 }
    const { db, rpcCalls } = canned({ stay_documents: [tiny] })
    const r = await archiveApproved(db, { accountId: 'a', ids: ['d1'], actor: 'o', now: new Date('2026-10-20T00:00:00Z') })
    expect(r.archived).toBe(0)
    expect(rpcCalls.length).toBe(0)
  })
  it('a stay that is not checked out, or a copy that does not match, is never offered', async () => {
    const live = { ...row('d1'), stays: { stay_ref: 'x', status: 'registered', checkout_at: old } }
    const bad = { ...row('d2'), drive_checksum: 'cd'.repeat(32) }
    const { db, rpcCalls } = canned({ stay_documents: [live, bad] })
    const r = await archiveApproved(db, { accountId: 'a', ids: ['d1', 'd2'], actor: 'o', now: new Date('2026-10-20T00:00:00Z') })
    expect(r.archived).toBe(0)
    expect(rpcCalls.length).toBe(0)
  })
  it('vi is available', () => expect(vi).toBeTruthy())
})
