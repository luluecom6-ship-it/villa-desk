import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/stays/<id>/checkout   caretakers (agent) and above.
// Marks a registered / checked-in stay as checked out (history is kept; the
// number is free for a new booking). Nothing is deleted.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const { data, error } = await supabaseAdmin()
      .from('stays')
      .update({ status: 'checked_out' })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .in('status', ['registered', 'checked_in'])
      .select('id')
    if (error) return NextResponse.json({ error: 'failed' }, { status: 500 })
    if (!data || data.length === 0) return NextResponse.json({ error: 'not_active' }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
