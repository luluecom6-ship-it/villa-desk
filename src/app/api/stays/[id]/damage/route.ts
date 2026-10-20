import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { notifyStaff } from '@/lib/stays/messaging/notify'
import { isRunKind, parseDamage } from '@/lib/stays/checklist/logic'
import { actorName, damageForRole, loadLiveStay, UUID } from '@/lib/stays/checklist/server'

// POST  raise a damage report on a stay. Caretaker and above. { title, description?, item_key?, run_kind?,
//       estimated_cost? }  The cost is accepted from owner/admin only (a caretaker's value is ignored).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const parsed = parseDamage(body, isAdmin)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const db = supabaseAdmin()
    const stay = await loadLiveStay(db, ctx.accountId, id)
    if (!stay) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    let runId: string | null = null
    if (isRunKind(body?.run_kind)) {
      const { data: run } = await db.from('checklist_runs').select('id').eq('stay_id', id).eq('kind', body.run_kind).maybeSingle()
      runId = (run as { id: string } | null)?.id ?? null
    }
    const name = await actorName(db, ctx.userId)
    const { data, error } = await db.rpc('damage_create', { p_account_id: ctx.accountId, p_stay_id: id, p_run_id: runId, p_actor: ctx.userId, p_actor_name: name, p_values: parsed.value })
    if (error || !data) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    const report = data as { id: string; report_no: number; title: string }
    // Owner and admins hear about it (a caretaker raising it does not need telling).
    await notifyStaff(db, ctx.accountId, `Damage reported: ${stay.stay_ref}`, `#${report.report_no} ${report.title}${name ? ` (by ${name})` : ''}. Open Stays → Damage reports.`).catch(() => undefined)
    return NextResponse.json({ damage: damageForRole(report as unknown as Record<string, unknown>, isAdmin) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
