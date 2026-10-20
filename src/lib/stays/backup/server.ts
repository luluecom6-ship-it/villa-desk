import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FORM_BUCKET } from '../public-form'
import { notifyStaff } from '../messaging/notify'
import { copyMatches, driveFileName, meter, proposeArchive, storageLimit, type ArchiveCandidate } from './logic'

// Server side of the Drive backup / archive flow (PDR 13.4). The Drive upload itself is done by
// n8n (docs/n8n-drive-backup.json); these functions hand n8n the files to copy, check what it
// reports back, run the storage meter and, with the owner's approval, archive.

const TEN_MINUTES = 600
const DAY_MS = 24 * 60 * 60 * 1000

export interface PendingFile {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  downloadUrl: string
}

/** Files without a verified Drive copy yet, with a short-lived download link for n8n. */
export async function loadPendingCopies(db: SupabaseClient, limit = 25): Promise<PendingFile[]> {
  const { data } = await db
    .from('stay_documents')
    .select('id, side, storage_path, content_type, size_bytes, sha256, stays(stay_ref), stay_guests(role)')
    .is('drive_copied_at', null)
    .is('archived_at', null)
    .order('uploaded_at', { ascending: true })
    .limit(limit)
  const out: PendingFile[] = []
  for (const d of (data ?? []) as unknown as Array<{ id: string; side: string; storage_path: string; content_type: string; size_bytes: number; sha256: string; stays: { stay_ref: string } | null; stay_guests: { role: string } | null }>) {
    const { data: signed } = await db.storage.from(FORM_BUCKET).createSignedUrl(d.storage_path, TEN_MINUTES)
    if (!signed?.signedUrl) continue
    out.push({
      id: d.id,
      fileName: driveFileName({ stayRef: d.stays?.stay_ref ?? 'stay', role: d.stay_guests?.role ?? 'guest', side: d.side, id: d.id, contentType: d.content_type }),
      contentType: d.content_type,
      sizeBytes: d.size_bytes,
      sha256: d.sha256,
      downloadUrl: signed.signedUrl,
    })
  }
  return out
}

/** MD5 of the stored object, for Drive copies verified by Drive's own md5Checksum (n8n cannot hash binaries). */
async function md5OfObject(db: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await db.storage.from(FORM_BUCKET).download(path)
  if (error || !data) return null
  return createHash('md5').update(Buffer.from(await data.arrayBuffer())).digest('hex')
}

export type ConfirmResult = { ok: true } | { ok: false; error: 'not_found' | 'mismatch' | 'bad_request' }

/** n8n reports the Drive copy. It counts as backed up only if size and SHA-256 match ours. */
export async function confirmCopy(
  db: SupabaseClient,
  body: { id?: unknown; drive_file_id?: unknown; drive_url?: unknown; size?: unknown; sha256?: unknown; md5?: unknown },
): Promise<ConfirmResult> {
  const id = typeof body.id === 'string' ? body.id : ''
  const fileId = typeof body.drive_file_id === 'string' ? body.drive_file_id.trim() : ''
  if (!id || !fileId || fileId.length > 200) return { ok: false, error: 'bad_request' }
  const { data: doc } = await db.from('stay_documents').select('id, account_id, stay_id, size_bytes, sha256, storage_path').eq('id', id).maybeSingle()
  if (!doc) return { ok: false, error: 'not_found' }

  // Verified by SHA-256 if n8n can supply it, else by Drive's md5Checksum compared with the md5 of the
  // bytes we hold (plus the size). Either way the stored sha256 is what the database records.
  let verified = false
  if (body.sha256) {
    verified = copyMatches(doc as { size_bytes: number; sha256: string }, { size: body.size, sha256: body.sha256 })
  } else if (typeof body.md5 === 'string' && Number(body.size) === Number(doc.size_bytes)) {
    const ours = await md5OfObject(db, doc.storage_path as string)
    verified = !!ours && ours === body.md5.toLowerCase()
  }
  if (!verified) {
    await db.from('document_archive_log').insert({ account_id: doc.account_id, stay_id: doc.stay_id, document_id: doc.id, action: 'copy_failed', detail: 'size_or_checksum_mismatch' })
    await notifyStaff(db, doc.account_id, 'ID backup failed a check', 'A Drive copy did not match the original file (size or checksum). The file stays in Supabase and will be copied again.')
    return { ok: false, error: 'mismatch' }
  }
  const url = typeof body.drive_url === 'string' ? body.drive_url.slice(0, 500) : null
  const { error } = await db
    .from('stay_documents')
    .update({ drive_file_id: fileId, drive_url: url, drive_checksum: (doc as { sha256: string }).sha256, drive_size_bytes: Number(body.size), drive_copied_at: new Date().toISOString(), drive_checked_at: new Date().toISOString(), drive_missing_at: null })
    .eq('id', id)
  if (error) return { ok: false, error: 'bad_request' }
  await db.from('document_archive_log').insert({ account_id: doc.account_id, stay_id: doc.stay_id, document_id: doc.id, action: 'copied' })
  return { ok: true }
}

/** Files that have a Drive copy, for the weekly "does it still exist" check. */
export async function loadVerifyList(db: SupabaseClient, limit = 500) {
  const { data } = await db
    .from('stay_documents')
    .select('id, drive_file_id, archived_at')
    .not('drive_file_id', 'is', null)
    .order('drive_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  return (data ?? []) as Array<{ id: string; drive_file_id: string; archived_at: string | null }>
}

/** n8n reports which Drive files exist. A missing one raises an alert (louder if it is the only copy). */
export async function applyVerifyResults(
  db: SupabaseClient,
  results: Array<{ id?: unknown; exists?: unknown }>,
): Promise<{ checked: number; missing: number }> {
  let checked = 0
  let missing = 0
  const now = new Date().toISOString()
  for (const r of results.slice(0, 1000)) {
    if (typeof r.id !== 'string' || typeof r.exists !== 'boolean') continue
    const { data: doc } = await db.from('stay_documents').select('id, account_id, stay_id, archived_at, drive_missing_at').eq('id', r.id).maybeSingle()
    if (!doc) continue
    checked++
    const wasMissing = doc.drive_missing_at
    if (r.exists) {
      await db.from('stay_documents').update({ drive_checked_at: now, drive_missing_at: null }).eq('id', doc.id)
      if (wasMissing) await db.from('document_archive_log').insert({ account_id: doc.account_id, stay_id: doc.stay_id, document_id: doc.id, action: 'drive_found' })
      continue
    }
    missing++
    await db.from('stay_documents').update({ drive_checked_at: now, drive_missing_at: wasMissing ?? now }).eq('id', doc.id)
    if (!wasMissing) {
      await db.from('document_archive_log').insert({ account_id: doc.account_id, stay_id: doc.stay_id, document_id: doc.id, action: 'drive_missing', detail: doc.archived_at ? 'archived_file_missing_in_drive' : 'backup_missing_in_drive' })
      await notifyStaff(
        db,
        doc.account_id,
        doc.archived_at ? 'URGENT: an archived ID file is missing from Drive' : 'A Drive backup of an ID file is missing',
        doc.archived_at ? 'Supabase no longer has this file. Restore it in Drive (check the Drive bin) as soon as possible.' : 'It will be copied again from Supabase.',
      )
      if (!doc.archived_at) await db.from('stay_documents').update({ drive_copied_at: null, drive_file_id: null, drive_checksum: null, drive_size_bytes: null, drive_url: null }).eq('id', doc.id)
    }
  }
  return { checked, missing }
}

// ---------------------------------------------------------------- storage meter

export async function storageUsed(db: SupabaseClient, accountId: string): Promise<number> {
  const { data } = await db.from('stay_documents').select('size_bytes').eq('account_id', accountId).is('archived_at', null).limit(20000)
  return (data ?? []).reduce((n: number, r: { size_bytes: number }) => n + Number(r.size_bytes), 0)
}

export async function storageSummary(db: SupabaseClient, accountId: string) {
  const [used, { data: docs }] = await Promise.all([
    storageUsed(db, accountId),
    db.from('stay_documents').select('drive_copied_at, drive_missing_at, archived_at').eq('account_id', accountId).limit(20000),
  ])
  const all = (docs ?? []) as Array<{ drive_copied_at: string | null; drive_missing_at: string | null; archived_at: string | null }>
  return {
    ...meter(used, storageLimit(process.env.STORAGE_LIMIT_BYTES)),
    files: all.length,
    backedUp: all.filter((d) => d.drive_copied_at && !d.drive_missing_at).length,
    archived: all.filter((d) => d.archived_at).length,
    driveMissing: all.filter((d) => d.drive_missing_at).length,
  }
}

/** 70% / 90% alert to the owner and admins, at most once a day per level. */
export async function alertIfStorageHigh(db: SupabaseClient, accountId: string, now: Date = new Date()): Promise<'ok' | 'amber' | 'red'> {
  const m = meter(await storageUsed(db, accountId), storageLimit(process.env.STORAGE_LIMIT_BYTES))
  if (m.level === 'ok') return 'ok'
  const title = m.level === 'red' ? `ID storage is ${m.percent}% full` : `ID storage is ${m.percent >= 70 ? 'getting full' : 'filling'} (${m.percent}%)`
  const key = m.level === 'red' ? 'ID storage is ' : 'ID storage is getting'
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const { data: recent } = await db.from('notifications').select('id').eq('account_id', accountId).ilike('title', `${key}%`).gte('created_at', since).limit(1)
  if (recent && recent.length > 0) return m.level
  await notifyStaff(db, accountId, title, 'Open Stays → Storage and backup. The owner can approve moving old, backed-up ID files to Drive.')
  return m.level
}

// ---------------------------------------------------------------- archive

/** Verified, not-yet-archived files of checked-out stays: the only ones that can ever be archived. */
export async function loadArchiveCandidates(db: SupabaseClient, accountId: string): Promise<ArchiveCandidate[]> {
  const { data } = await db
    .from('stay_documents')
    .select('id, size_bytes, sha256, drive_checksum, drive_size_bytes, drive_file_id, stays!inner(stay_ref, status, checkout_at)')
    .eq('account_id', accountId)
    .is('archived_at', null)
    .is('drive_missing_at', null)
    .not('drive_copied_at', 'is', null)
    .limit(20000)
  const rows = (data ?? []) as unknown as Array<{ id: string; size_bytes: number; sha256: string; drive_checksum: string | null; drive_size_bytes: number | null; drive_file_id: string | null; stays: { stay_ref: string; status: string; checkout_at: string } }>
  return rows
    .filter((r) => r.stays?.status === 'checked_out' && r.drive_file_id && copyMatches(r, { size: r.drive_size_bytes, sha256: r.drive_checksum }))
    .map((r) => ({ id: r.id, stayRef: r.stays.stay_ref, checkoutAt: r.stays.checkout_at, sizeBytes: Number(r.size_bytes) }))
}

export async function loadProposal(db: SupabaseClient, accountId: string, now: Date = new Date()) {
  const [used, candidates] = await Promise.all([storageUsed(db, accountId), loadArchiveCandidates(db, accountId)])
  return proposeArchive(candidates, used, storageLimit(process.env.STORAGE_LIMIT_BYTES), now)
}

/**
 * Archive what the owner approved. The proposal is recomputed here and each id must be on it:
 * the client's list is never trusted. Mark archived first (the database checks the verified copy),
 * then remove the Supabase object; if the removal fails the file is simply left behind and logged.
 */
export async function archiveApproved(
  db: SupabaseClient,
  args: { accountId: string; ids: string[]; actor: string; now?: Date },
): Promise<{ archived: number; skipped: number; deleteFailed: number }> {
  const proposal = await loadProposal(db, args.accountId, args.now)
  const allowed = new Set(proposal.files.map((f) => f.id))
  let archived = 0, skipped = 0, deleteFailed = 0
  for (const id of args.ids.slice(0, 500)) {
    if (!allowed.has(id)) { skipped++; continue }
    const { data: doc } = await db.from('stay_documents').select('id, stay_id, storage_path').eq('id', id).eq('account_id', args.accountId).maybeSingle()
    if (!doc) { skipped++; continue }
    const { data: did, error } = await db.rpc('archive_document', { p_account_id: args.accountId, p_document_id: id, p_actor: args.actor })
    if (error || did !== true) { skipped++; continue }
    archived++
    const { error: rmErr } = await db.storage.from(FORM_BUCKET).remove([doc.storage_path as string])
    if (rmErr) {
      deleteFailed++
      await db.from('document_archive_log').insert({ account_id: args.accountId, stay_id: doc.stay_id, document_id: id, action: 'archive_delete_failed', actor: args.actor })
    }
  }
  return { archived, skipped, deleteFailed }
}

// ---------------------------------------------------------------- database export

const EXPORT_TABLES = ['properties', 'stays', 'stay_guests', 'stay_acceptances', 'house_rules_versions', 'deposits', 'deposit_audit', 'stay_id_reviews', 'stay_messages', 'stay_message_log', 'document_archive_log', 'food_items', 'food_orders'] as const

/** The weekly database export (n8n saves it to the Drive folder). No ID images; ID numbers are last-4 only by design. */
export async function buildExport(db: SupabaseClient, now: Date = new Date()) {
  const tables: Record<string, unknown[]> = {}
  for (const t of EXPORT_TABLES) {
    const { data } = await db.from(t).select('*').limit(50000)
    tables[t] = data ?? []
  }
  const { data: docs } = await db
    .from('stay_documents')
    .select('id, account_id, stay_id, guest_id, side, content_type, size_bytes, sha256, uploaded_at, superseded_at, drive_file_id, drive_url, drive_copied_at, archived_at')
    .limit(50000)
  tables.stay_documents = docs ?? []
  return { exportedAt: now.toISOString(), tables }
}
