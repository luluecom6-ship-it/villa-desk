// POST /api/evolution/test (admin+) — sends one test message to the linked number itself.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { EvolutionError, sendText } from '@/lib/evolution/client'
import { recordSend } from '@/lib/evolution/safety-server'
import { connFromRow, evolutionSetupError, loadEvolutionConfig } from '@/lib/evolution/server'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()
    const row = await loadEvolutionConfig(ctx.accountId, db)
    if (!row || row.state !== 'open' || !row.connected_number) {
      return NextResponse.json({ error: 'The number is not connected yet.' }, { status: 400 })
    }
    try {
      await sendText(connFromRow(row), row.connected_number, 'Test message from the Villa Guest Desk. The WhatsApp link works.')
      await recordSend(ctx.accountId, { ok: true, kind: 'test', phone: row.connected_number }, db)
      return NextResponse.json({ ok: true })
    } catch (e) {
      const status = e instanceof EvolutionError ? e.status : 0
      await recordSend(ctx.accountId, { ok: false, kind: 'test', phone: row.connected_number, errorCode: status ? `evolution_${status}` : 'evolution_unreachable' }, db)
      return NextResponse.json({ error: 'The test message could not be sent.' }, { status: 502 })
    }
  } catch (err) {
    const setup = evolutionSetupError(err)
    if (setup) return NextResponse.json({ error: setup }, { status: 500 })
    return toErrorResponse(err)
  }
}
