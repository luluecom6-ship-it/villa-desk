import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { archiveApproved, loadProposal, storageSummary } from '@/lib/stays/backup/server'

export const maxDuration = 60

// Archive proposal and approval (PDR 13.4). OWNER ONLY: a caretaker or manager cannot approve.
// GET   the meter and the proposal (nothing is removed).
// POST  { ids } approve: the server recomputes the proposal and archives only ids on it.
export async function GET() {
  try {
    const ctx = await requireRole('owner')
    const db = supabaseAdmin()
    const [summary, proposal] = await Promise.all([storageSummary(db, ctx.accountId), loadProposal(db, ctx.accountId)])
    return NextResponse.json({ summary, proposal }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner')
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) return NextResponse.json({ error: 'nothing_selected' }, { status: 400 })
    return NextResponse.json(await archiveApproved(supabaseAdmin(), { accountId: ctx.accountId, ids, actor: ctx.userId }))
  } catch (err) {
    return toErrorResponse(err)
  }
}
