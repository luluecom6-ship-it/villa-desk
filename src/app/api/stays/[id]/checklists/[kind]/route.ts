import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isRunKind, parseAnswer, unanswered, type Answers, type ChecklistItem } from '@/lib/stays/checklist/logic'
import { actorName, loadLiveStay, loadTemplateItems, UUID } from '@/lib/stays/checklist/server'

// POST  start the checklist (snapshot of the current template). Starting twice returns the same run.
// PATCH { key, answer }  save one item   |   { complete: true }  finish (every item must be answered; then locked)
// Caretaker and above.
type Ctx = { params: Promise<{ id: string; kind: string }> }

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('agent')
    const { id, kind } = await params
    if (!UUID.test(id) || !isRunKind(kind)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const stay = await loadLiveStay(db, ctx.accountId, id)
    if (!stay) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const { data: existing } = await db.from('checklist_runs').select('id').eq('stay_id', id).eq('kind', kind).maybeSingle()
    if (existing) return NextResponse.json({ ok: true, run_id: (existing as { id: string }).id })
    const items = await loadTemplateItems(db, ctx.accountId, stay.property_id)
    const { data, error } = await db
      .from('checklist_runs')
      .insert({ account_id: ctx.accountId, stay_id: id, kind, template_snapshot: items, started_by: ctx.userId, started_by_name: await actorName(db, ctx.userId) })
      .select('id')
      .single()
    if (error || !data) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    return NextResponse.json({ ok: true, run_id: (data as { id: string }).id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireRole('agent')
    const { id, kind } = await params
    if (!UUID.test(id) || !isRunKind(kind)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const body = (await request.json().catch(() => null)) as { key?: unknown; answer?: unknown; complete?: unknown } | null
    if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const db = supabaseAdmin()
    const { data: run } = await db.from('checklist_runs').select('id, status, template_snapshot, answers').eq('stay_id', id).eq('kind', kind).eq('account_id', ctx.accountId).maybeSingle()
    const r = run as { id: string; status: string; template_snapshot: ChecklistItem[]; answers: Answers } | null
    if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (r.status === 'completed') return NextResponse.json({ error: 'completed' }, { status: 409 })

    if (body.complete === true) {
      const missing = unanswered(r.template_snapshot, r.answers)
      if (missing.length > 0) return NextResponse.json({ error: 'incomplete', missing: missing.map((m) => m.key) }, { status: 409 })
      const { error } = await db.from('checklist_runs').update({ status: 'completed', completed_at: new Date().toISOString(), completed_by: ctx.userId, completed_by_name: await actorName(db, ctx.userId) }).eq('id', r.id).eq('status', 'in_progress')
      if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
      // Finishing the arrival checklist means the guest has arrived: Registered -> Checked in.
      if (kind === 'arrival') await db.from('stays').update({ status: 'checked_in' }).eq('id', id).eq('account_id', ctx.accountId).eq('status', 'registered')
      return NextResponse.json({ ok: true })
    }

    const item = r.template_snapshot.find((i) => i.key === body.key)
    if (!item) return NextResponse.json({ error: 'unknown_item' }, { status: 400 })
    const parsed = parseAnswer(item, body.answer)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { error } = await db.rpc('checklist_save_answer', { p_account_id: ctx.accountId, p_run_id: r.id, p_key: item.key, p_answer: parsed.value })
    if (error) return NextResponse.json({ error: /cannot be changed/.test(error.message) ? 'completed' : 'save_failed' }, { status: /cannot be changed/.test(error.message) ? 409 : 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
