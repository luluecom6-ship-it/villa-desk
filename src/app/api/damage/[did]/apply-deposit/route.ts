import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { actorName, UUID } from '@/lib/stays/checklist/server'

// Take the damage's estimated cost off the stay's security deposit. OWNER / ADMIN only (money). Atomic, once.
export async function POST(_req: Request, { params }: { params: Promise<{ did: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const { did } = await params
    if (!UUID.test(did)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data, error } = await db.rpc('damage_apply_to_deposit', { p_account_id: ctx.accountId, p_damage_id: did, p_actor: ctx.userId, p_actor_name: await actorName(db, ctx.userId) })
    if (error) {
      const code = /damage:([a-z_]+)/.exec(error.message)?.[1] ?? 'save_failed'
      return NextResponse.json({ error: code }, { status: code === 'not_found' ? 404 : code === 'save_failed' ? 500 : 409 })
    }
    return NextResponse.json({ damage: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
