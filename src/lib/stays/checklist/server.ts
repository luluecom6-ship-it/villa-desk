import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkUpload, MAX_REQUEST_BYTES, sha256Hex } from '../files'
import { FORM_BUCKET } from '../public-form'
import { DEFAULT_ITEMS, MAX_PHOTOS_PER_ITEM, type ChecklistItem } from './logic'

// Server helpers for checklists and damage reports. Always called with the service client AFTER the route
// has checked the caller's role; every query is pinned to the caller's account.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function actorName(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from('profiles').select('full_name').eq('user_id', userId).maybeSingle()
  return (data as { full_name?: string } | null)?.full_name ?? null
}

/** A stay a checklist or damage report can be attached to (not cancelled or sample). */
export async function loadLiveStay(db: SupabaseClient, accountId: string, stayId: string) {
  const { data } = await db.from('stays').select('id, stay_ref, status, property_id').eq('id', stayId).eq('account_id', accountId).maybeSingle()
  const s = data as { id: string; stay_ref: string; status: string; property_id: string } | null
  return s && !['cancelled', 'sample'].includes(s.status) ? s : null
}

export async function loadTemplateItems(db: SupabaseClient, accountId: string, propertyId: string): Promise<ChecklistItem[]> {
  const { data } = await db.from('checklist_templates').select('items').eq('account_id', accountId).eq('property_id', propertyId).maybeSingle()
  const items = (data as { items?: ChecklistItem[] } | null)?.items
  return Array.isArray(items) && items.length > 0 ? items : DEFAULT_ITEMS
}

/** Store one photo (jpeg / png / webp, content-sniffed) in the private bucket and record it. */
export async function storePhoto(
  db: SupabaseClient,
  args: { accountId: string; stayId: string; runId?: string; damageId?: string; itemKey?: string | null; file: File; userId: string },
): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const bytes = new Uint8Array(await args.file.arrayBuffer())
  const check = checkUpload(bytes)
  if (!check.ok || check.type.contentType === 'application/pdf') return { ok: false, status: 400, error: 'bad_file' }
  if (bytes.byteLength > MAX_REQUEST_BYTES) return { ok: false, status: 413, error: 'too_large' }

  // At most MAX_PHOTOS_PER_ITEM per item (or per damage report), so a stuck phone cannot fill the storage.
  let q = db.from('checklist_photos').select('id', { count: 'exact', head: true }).eq('account_id', args.accountId)
  q = args.damageId ? q.eq('damage_id', args.damageId) : q.eq('run_id', args.runId as string).eq('item_key', args.itemKey ?? '')
  const { count } = await q
  if ((count ?? 0) >= MAX_PHOTOS_PER_ITEM) return { ok: false, status: 409, error: 'too_many' }

  const path = `account-${args.accountId}/checklists/${args.stayId}/${randomUUID()}.${check.type.ext}`
  const { error: upErr } = await db.storage.from(FORM_BUCKET).upload(path, bytes, { contentType: check.type.contentType, upsert: false })
  if (upErr) return { ok: false, status: 500, error: 'upload_failed' }
  const { data, error } = await db
    .from('checklist_photos')
    .insert({
      account_id: args.accountId, stay_id: args.stayId, run_id: args.runId ?? null, damage_id: args.damageId ?? null,
      item_key: args.itemKey ?? null, storage_path: path, content_type: check.type.contentType,
      size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes), uploaded_by: args.userId,
    })
    .select('id')
    .single()
  if (error || !data) {
    await db.storage.from(FORM_BUCKET).remove([path]) // our own unrecorded upload only
    return { ok: false, status: 500, error: 'save_failed' }
  }
  return { ok: true, id: (data as { id: string }).id }
}

/** Damage rows for caretakers never carry money. */
export function damageForRole<T extends Record<string, unknown>>(row: T, isAdmin: boolean) {
  if (isAdmin) return row
  const { estimated_cost: _c, deposit_deduction: _d, applied_at: _a, applied_by: _b, ...rest } = row as Record<string, unknown>
  void _c; void _d; void _a; void _b
  return rest
}

export const DAMAGE_COLUMNS = 'id, stay_id, run_id, item_key, report_no, title, description, status, estimated_cost, deposit_deduction, applied_at, applied_by, raised_by_name, created_at, updated_at'
