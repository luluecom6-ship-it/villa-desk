// POST /api/evolution/settings (admin+) — safety settings: daily maximum, sending hours, auto-pause.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server'

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null)

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const maxDaily = int(b?.maxDaily)
    const start = int(b?.windowStartHour)
    const end = int(b?.windowEndHour)
    if (maxDaily === null || start === null || end === null || typeof b?.autoPause !== 'boolean') {
      return NextResponse.json({ error: 'Invalid settings.' }, { status: 400 })
    }
    if (maxDaily < 1 || maxDaily > 1000 || start < 0 || start > 23 || end < 1 || end > 24 || start >= end) {
      return NextResponse.json({ error: 'Check the daily maximum and the sending hours.' }, { status: 400 })
    }
    const db = supabaseAdmin()
    if (!(await loadEvolutionConfig(ctx.accountId, db))) return NextResponse.json({ error: 'Not linked.' }, { status: 400 })
    const { error } = await db
      .from('evolution_config')
      .update({ max_daily: maxDaily, window_start_hour: start, window_end_hour: end, auto_pause: b.autoPause, updated_by: ctx.userId, updated_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
    if (error) return NextResponse.json({ error: 'Could not save.' }, { status: 500 })
    await logEvolutionEvent(ctx.accountId, 'settings', 'saved', db)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
