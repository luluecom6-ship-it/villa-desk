import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { diffRuns, type Answers, type ChecklistItem } from '@/lib/stays/checklist/logic'
import { DAMAGE_COLUMNS, damageForRole, UUID } from '@/lib/stays/checklist/server'

// Both checklists of a stay (arrival + check-out), their photos, the differences between them and the stay's
// damage reports. Caretaker and above. Damage cost / deduction are included for owner/admin only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data: stay } = await db.from('stays').select('id, stay_ref, guest_name, status').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()
    if (!stay) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const [{ data: runs }, { data: photos }, { data: damage }] = await Promise.all([
      db.from('checklist_runs').select('id, kind, status, template_snapshot, answers, started_by_name, started_at, completed_at, completed_by_name').eq('stay_id', id).eq('account_id', ctx.accountId),
      db.from('checklist_photos').select('id, run_id, damage_id, item_key').eq('stay_id', id).eq('account_id', ctx.accountId).order('uploaded_at'),
      db.from('damage_reports').select(DAMAGE_COLUMNS).eq('stay_id', id).eq('account_id', ctx.accountId).order('created_at', { ascending: false }),
    ])
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const byRun: Record<string, Record<string, string[]>> = {}
    const byDamage: Record<string, string[]> = {}
    for (const p of (photos ?? []) as Array<{ id: string; run_id: string | null; damage_id: string | null; item_key: string | null }>) {
      if (p.run_id) ((byRun[p.run_id] ??= {})[p.item_key ?? ''] ??= []).push(p.id)
      if (p.damage_id) (byDamage[p.damage_id] ??= []).push(p.id)
    }
    const shaped: Record<string, unknown> = {}
    for (const r of (runs ?? []) as Array<{ id: string; kind: string; template_snapshot: ChecklistItem[]; answers: Answers }>) {
      shaped[r.kind] = { ...r, photos: byRun[r.id] ?? {} }
    }
    const a = shaped.arrival as { template_snapshot: ChecklistItem[]; answers: Answers } | undefined
    const c = shaped.checkout as { answers: Answers } | undefined
    const differences = a && c ? diffRuns(a.template_snapshot, a.answers, c.answers) : []
    return NextResponse.json({
      stay: { id: stay.id, stay_ref: stay.stay_ref, guest_name: stay.guest_name, status: stay.status },
      runs: shaped,
      differences,
      damage: ((damage ?? []) as Array<Record<string, unknown>>).map((d) => ({ ...damageForRole(d, isAdmin), photos: byDamage[d.id as string] ?? [] })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
