import type { SupabaseClient } from '@supabase/supabase-js'
import { FORM_BUCKET } from '../public-form'

// Owner-approved deletion of old inspection / damage photos (migration 069). No Drive copy is made.
// Only photos of stays checked out more than PHOTO_KEEP_DAYS ago are ever eligible, and photos of a damage report
// that is still open or being discussed are kept (they may be evidence for a deposit deduction).

export const PHOTO_KEEP_DAYS = 90
const DAY_MS = 86_400_000
const MAX_PER_RUN = 500

export interface PhotoCandidate { id: string; stayId: string; sizeBytes: number; storagePath: string }

export interface Row {
  id: string
  stay_id: string
  size_bytes: number
  storage_path: string
  stays: { status: string; checkout_at: string } | null
  damage_reports: { status: string } | null
}

export async function loadPhotoCandidates(db: SupabaseClient, accountId: string, now: Date = new Date()): Promise<PhotoCandidate[]> {
  const [{ data }, { data: done }] = await Promise.all([
    db.from('checklist_photos').select('id, stay_id, size_bytes, storage_path, stays!inner(status, checkout_at), damage_reports(status)').eq('account_id', accountId).order('uploaded_at').limit(20000),
    db.from('checklist_photo_purges').select('photo_id').eq('account_id', accountId).limit(50000),
  ])
  return eligiblePhotos((data ?? []) as unknown as Row[], new Set(((done ?? []) as Array<{ photo_id: string }>).map((r) => r.photo_id)), now)
}

/** Pure rule: checked-out > 90 days ago, not already deleted, and no unsettled damage report. */
export function eligiblePhotos(rows: Row[], purged: Set<string>, now: Date): PhotoCandidate[] {
  const cutoff = now.getTime() - PHOTO_KEEP_DAYS * DAY_MS
  return rows
    .filter((r) => !purged.has(r.id))
    .filter((r) => r.stays?.status === 'checked_out' && new Date(r.stays.checkout_at).getTime() < cutoff)
    .filter((r) => !r.damage_reports || ['settled', 'waived'].includes(r.damage_reports.status))
    .map((r) => ({ id: r.id, stayId: r.stay_id, sizeBytes: Number(r.size_bytes), storagePath: r.storage_path }))
}

export async function photoCleanupSummary(db: SupabaseClient, accountId: string, now: Date = new Date()) {
  const c = await loadPhotoCandidates(db, accountId, now)
  return { keepDays: PHOTO_KEEP_DAYS, count: c.length, bytes: c.reduce((n, p) => n + p.sizeBytes, 0) }
}

/** Delete the file first, then write the log row; a file that is already gone counts as deleted. */
export async function purgeOldPhotos(db: SupabaseClient, args: { accountId: string; actor: string; now?: Date }) {
  const list = (await loadPhotoCandidates(db, args.accountId, args.now)).slice(0, MAX_PER_RUN)
  let deleted = 0, failed = 0, bytes = 0
  for (const p of list) {
    const { error } = await db.storage.from(FORM_BUCKET).remove([p.storagePath])
    if (error) { failed++; continue }
    const { error: logErr } = await db.from('checklist_photo_purges').insert({ account_id: args.accountId, stay_id: p.stayId, photo_id: p.id, size_bytes: p.sizeBytes, purged_by: args.actor })
    if (logErr && logErr.code !== '23505') { failed++; continue }
    deleted++
    bytes += p.sizeBytes
  }
  return { deleted, failed, bytes, remaining: Math.max(0, (await loadPhotoCandidates(db, args.accountId, args.now)).length) }
}
