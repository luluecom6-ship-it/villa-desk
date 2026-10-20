import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { defaultDepositStatus, parseDeposit } from '@/lib/stays/deposits/logic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Security deposit for a stay (PDR section 9). Owner and admin only: caretakers never see amounts.
// GET  { deposit | null, defaultStatus, audit[] }
// PUT  the whole deposit form; validated by parseDeposit, saved by the save_deposit function
//      (one transaction; the audit row records who changed what, old and new).

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data: stay } = await db.from('stays').select('id, source').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()
    if (!stay) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const [{ data: deposit }, { data: audit }] = await Promise.all([
      db.from('deposits').select('*').eq('stay_id', id).eq('account_id', ctx.accountId).maybeSingle(),
      db.from('deposit_audit').select('id, action, old_values, new_values, changed_by_name, created_at').eq('stay_id', id).eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(20),
    ])
    return NextResponse.json({ deposit: deposit ?? null, defaultStatus: defaultDepositStatus(stay.source as string), audit: audit ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const body = await request.json().catch(() => null)
    const parsed = parseDeposit(body)
    if (!parsed.ok) return NextResponse.json({ error: 'fix_fields', fields: parsed.errors }, { status: 400 })

    const db = supabaseAdmin()
    const { data: me } = await db.from('profiles').select('full_name').eq('user_id', ctx.userId).maybeSingle()
    const { data, error } = await db.rpc('save_deposit', {
      p_account_id: ctx.accountId,
      p_stay_id: id,
      p_actor: ctx.userId,
      p_actor_name: (me as { full_name?: string } | null)?.full_name ?? null,
      p_values: parsed.value,
    })
    if (error) {
      if (/deposit:not_found/.test(error.message)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    }
    return NextResponse.json({ deposit: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
