// POST /api/evolution/logout (admin+) — unlink the number. Re-link by scanning again.
// Queued guest messages stay queued; nothing is deleted.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { EvolutionError, logout } from '@/lib/evolution/client'
import { connFromRow, evolutionSetupError, loadEvolutionConfig, logEvolutionEvent } from '@/lib/evolution/server'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()
    const row = await loadEvolutionConfig(ctx.accountId, db)
    if (!row) return NextResponse.json({ error: 'Not linked.' }, { status: 400 })
    try {
      await logout(connFromRow(row))
    } catch (e) {
      // 400/404 = already logged out on the server; anything else is a real failure.
      if (!(e instanceof EvolutionError && (e.status === 400 || e.status === 404))) {
        await logEvolutionEvent(ctx.accountId, 'logout', 'error', db)
        return NextResponse.json({ error: 'Could not reach the Evolution server.' }, { status: 502 })
      }
    }
    await db
      .from('evolution_config')
      .update({ state: 'logged_out', qr_code: null, pairing_code: null, connected_number: null, profile_name: null, updated_at: new Date().toISOString(), updated_by: ctx.userId })
      .eq('account_id', ctx.accountId)
    await logEvolutionEvent(ctx.accountId, 'logout', 'by_admin', db)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const setup = evolutionSetupError(err)
    if (setup) return NextResponse.json({ error: setup }, { status: 500 })
    return toErrorResponse(err)
  }
}
