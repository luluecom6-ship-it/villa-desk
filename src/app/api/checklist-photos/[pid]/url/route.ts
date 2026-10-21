import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { FORM_BUCKET } from '@/lib/stays/public-form'
import { UUID } from '@/lib/stays/checklist/server'

// A 60-second link to an inspection / damage photo. Caretaker and above. (Guest ID images use their own,
// logged route; these photos are not identity documents.)
export async function POST(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { pid } = await params
    if (!UUID.test(pid)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data: p } = await db.from('checklist_photos').select('storage_path').eq('id', pid).eq('account_id', ctx.accountId).maybeSingle()
    if (!p) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const { data: gone } = await db.from('checklist_photo_purges').select('id').eq('photo_id', pid).maybeSingle()
    if (gone) return NextResponse.json({ error: 'deleted' }, { status: 410 })
    const { data: signed } = await db.storage.from(FORM_BUCKET).createSignedUrl((p as { storage_path: string }).storage_path, 60)
    if (!signed?.signedUrl) return NextResponse.json({ error: 'unavailable' }, { status: 502 })
    return NextResponse.json({ url: signed.signedUrl }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
