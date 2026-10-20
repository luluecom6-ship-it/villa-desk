import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isRunKind, type ChecklistItem } from '@/lib/stays/checklist/logic'
import { storePhoto, UUID } from '@/lib/stays/checklist/server'

// POST multipart { key, file }: a photo for one checklist item. Caretaker and above; not on a completed run.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id, kind } = await params
    if (!UUID.test(id) || !isRunKind(kind)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const form = await request.formData().catch(() => null)
    const key = form?.get('key')
    const file = form?.get('file')
    if (!form || typeof key !== 'string' || !(file instanceof File)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const db = supabaseAdmin()
    const { data: run } = await db.from('checklist_runs').select('id, status, template_snapshot').eq('stay_id', id).eq('kind', kind).eq('account_id', ctx.accountId).maybeSingle()
    const r = run as { id: string; status: string; template_snapshot: ChecklistItem[] } | null
    if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (r.status === 'completed') return NextResponse.json({ error: 'completed' }, { status: 409 })
    if (!r.template_snapshot.some((i) => i.key === key)) return NextResponse.json({ error: 'unknown_item' }, { status: 400 })
    const res = await storePhoto(db, { accountId: ctx.accountId, stayId: id, runId: r.id, itemKey: key, file, userId: ctx.userId })
    return res.ok ? NextResponse.json({ ok: true, photo_id: res.id }, { status: 201 }) : NextResponse.json({ error: res.error }, { status: res.status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
