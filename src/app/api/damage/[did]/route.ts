import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { DAMAGE_STATUSES } from '@/lib/stays/checklist/logic'
import { actorName, damageForRole, UUID } from '@/lib/stays/checklist/server'

// PATCH { status?, description?, estimated_cost? }. Caretakers may add detail and move Open -> Discussed;
// settling, waiving and every cost change are owner/admin only.
export async function PATCH(request: Request, { params }: { params: Promise<{ did: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { did } = await params
    if (!UUID.test(did)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!b) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const patch: Record<string, unknown> = {}
    if (b.status !== undefined) {
      if (!(DAMAGE_STATUSES as readonly string[]).includes(String(b.status))) return NextResponse.json({ error: 'status' }, { status: 400 })
      if (!isAdmin && !['open', 'discussed'].includes(String(b.status))) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      patch.status = b.status
    }
    if (b.description !== undefined) patch.description = String(b.description ?? '').trim().slice(0, 1000)
    if (b.estimated_cost !== undefined) {
      if (!isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const n = b.estimated_cost === '' || b.estimated_cost === null ? null : Number(b.estimated_cost)
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 10_000_000)) return NextResponse.json({ error: 'cost' }, { status: 400 })
      patch.estimated_cost = n === null ? null : Math.round(n * 100) / 100
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const db = supabaseAdmin()
    const { data, error } = await db.rpc('damage_update', { p_account_id: ctx.accountId, p_damage_id: did, p_actor: ctx.userId, p_actor_name: await actorName(db, ctx.userId), p_patch: patch })
    if (error) return NextResponse.json({ error: /not_found/.test(error.message) ? 'not_found' : 'save_failed' }, { status: /not_found/.test(error.message) ? 404 : 500 })
    return NextResponse.json({ damage: damageForRole(data as Record<string, unknown>, isAdmin) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
