// GET /api/evolution/status  (admin+) — what the link screen polls every 3 seconds.
// Never returns the instance token or the webhook secret.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { connectionState } from '@/lib/evolution/client'
import { dailyLimit, dayKeyIn } from '@/lib/evolution/safety'
import { connFromRow, evolutionServer, loadEvolutionConfig, propertyTimeZone } from '@/lib/evolution/server'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()
    let serverReady = true
    try {
      evolutionServer()
    } catch {
      serverReady = false
    }
    let row = await loadEvolutionConfig(ctx.accountId, db)
    if (!row) return NextResponse.json({ serverReady, linked: false, status: 'not_linked' })

    // Heal a missed webhook: while linking, ask the server for the real state.
    if (serverReady && (row.state === 'connecting' || row.state === 'unknown')) {
      try {
        const live = await connectionState(connFromRow(row))
        if (live !== row.state && live !== 'unknown') {
          await db.from('evolution_config').update({ state: live, ...(live === 'open' ? { qr_code: null, pairing_code: null } : {}) }).eq('account_id', ctx.accountId)
          row = { ...row, state: live, ...(live === 'open' ? { qr_code: null, pairing_code: null } : {}) }
        }
      } catch {
        /* keep the stored state */
      }
    }

    const tz = await propertyTimeZone(db, ctx.accountId)
    const now = new Date()
    const since = new Date(now.getTime() - 36 * 3_600_000).toISOString()
    const { data: sends } = await db.from('evolution_send_log').select('sent_at').eq('account_id', ctx.accountId).eq('kind', 'scheduled').eq('ok', true).gte('sent_at', since)
    const today = dayKeyIn(tz, now)
    const sentToday = (sends ?? []).filter((r: { sent_at: string }) => dayKeyIn(tz, new Date(r.sent_at)) === today).length

    const status = row.paused_at ? 'paused' : row.state === 'open' ? 'connected' : row.state === 'logged_out' ? 'logged_out' : row.state === 'connecting' || row.qr_code || row.pairing_code ? 'waiting' : 'not_linked'
    return NextResponse.json({
      serverReady,
      linked: true,
      status,
      state: row.state,
      qr: row.state === 'open' ? null : row.qr_code,
      pairingCode: row.state === 'open' ? null : row.pairing_code,
      connectedNumber: row.connected_number,
      profileName: row.profile_name,
      pausedReason: row.paused_reason,
      sentToday,
      dailyLimit: dailyLimit(row.warmup_started_at ? new Date(row.warmup_started_at) : null, now, row.max_daily),
      settings: { maxDaily: row.max_daily, windowStartHour: row.window_start_hour, windowEndHour: row.window_end_hour, autoPause: row.auto_pause, timeZone: tz },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
