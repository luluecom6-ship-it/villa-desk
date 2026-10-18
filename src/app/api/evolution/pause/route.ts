// POST /api/evolution/pause { paused: boolean } (admin+) — pause or resume sending by hand.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { pauseNumber, resumeNumber } from '@/lib/evolution/safety-server'
import { loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as { paused?: boolean } | null
    if (typeof body?.paused !== 'boolean') return NextResponse.json({ error: 'paused must be true or false.' }, { status: 400 })
    const db = supabaseAdmin()
    if (!(await loadEvolutionConfig(ctx.accountId, db))) return NextResponse.json({ error: 'Not linked.' }, { status: 400 })
    if (body.paused) await pauseNumber(ctx.accountId, 'paused_by_admin', db)
    else await resumeNumber(ctx.accountId, ctx.userId, db)
    await logEvolutionEvent(ctx.accountId, body.paused ? 'pause' : 'resume', 'by_admin', db)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
