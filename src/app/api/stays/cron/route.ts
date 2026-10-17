import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runStayScheduler } from '@/lib/stays/messaging/scheduler'

export const maxDuration = 60

// Stay-message scheduler (PDR 7.3). Call every 15 minutes from an external
// scheduler (host cron, Docker cron, n8n) with the header
//   x-cron-secret: <AUTOMATION_CRON_SECRET>
// the same shared secret the existing /api/automations/cron uses.
// Safe to call twice in a row: rows are unique per (stay, message) and are
// claimed before sending, so each message goes out once.
async function handle(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })

  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const summary = await runStayScheduler(supabaseAdmin(), { requestUrl: request.url })
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[stay-cron] failed:', (err as { code?: string })?.code ?? 'error')
    return NextResponse.json({ error: 'scheduler failed' }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
