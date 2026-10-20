import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { DAMAGE_STATUSES } from '@/lib/stays/checklist/logic'
import { DAMAGE_COLUMNS, damageForRole } from '@/lib/stays/checklist/server'

// All damage reports, newest first (?status=open|discussed|settled|waived). Caretaker and above; money only for owner/admin.
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const status = new URL(request.url).searchParams.get('status')
    const db = supabaseAdmin()
    let q = db.from('damage_reports').select(`${DAMAGE_COLUMNS}, stays(stay_ref, guest_name)`).eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(300)
    if (status && (DAMAGE_STATUSES as readonly string[]).includes(status)) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return NextResponse.json({ error: 'load_failed' }, { status: 500 })
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const ids = (data ?? []).map((d: { id: string }) => d.id)
    const { data: photos } = ids.length ? await db.from('checklist_photos').select('id, damage_id').in('damage_id', ids).order('uploaded_at') : { data: [] }
    const byDamage: Record<string, string[]> = {}
    for (const p of (photos ?? []) as Array<{ id: string; damage_id: string }>) (byDamage[p.damage_id] ??= []).push(p.id)
    return NextResponse.json({
      reports: (data ?? []).map((d: Record<string, unknown>) => ({ ...damageForRole(d, isAdmin), photos: byDamage[d.id as string] ?? [] })),
      canSeeCost: isAdmin,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
