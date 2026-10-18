// POST /api/evolution/webhook/<secret> — receiver for Evolution API events.
// The secret in the URL identifies the account (Evolution webhooks are not signed).
//   CONNECTION_UPDATE / QRCODE_UPDATED  live status + QR on the link screen
//   MESSAGES_UPSERT                     guest messages -> inbox + READY/1/2 stay logic
//   MESSAGES_UPDATE                     delivered / read ticks
// Answers 200 at once and processes in after(), so Evolution never retries.
// The event log keeps the event name and a one-word outcome only.
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { jidDigits } from '@/lib/evolution/client'
import { receiveUpdates, receiveUpsert } from '@/lib/evolution/receive'
import { connectionTroubleReason } from '@/lib/evolution/safety'
import { pauseNumber } from '@/lib/evolution/safety-server'
import { logEvolutionEvent, type EvolutionConfigRow } from '@/lib/evolution/server'

export const maxDuration = 60

interface Delivery {
  event?: string
  instance?: string
  data?: Record<string, unknown>
}

const norm = (e: string | undefined) => (e ?? '').toLowerCase().replace(/_/g, '.')

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params
  if (!/^[a-f0-9]{48}$/.test(secret)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const db = supabaseAdmin()
  const { data } = await db.from('evolution_config').select('*').eq('webhook_secret', secret).maybeSingle()
  const cfg = data as EvolutionConfigRow | null
  if (!cfg) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let body: Delivery
  try {
    body = (await request.json()) as Delivery
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }
  const accountId = cfg.account_id
  const event = norm(body.event)
  if (body.instance && body.instance !== cfg.instance_name) {
    return NextResponse.json({ ok: true })
  }

  const now = new Date().toISOString()
  try {
    if (event === 'connection.update') {
      const d = body.data ?? {}
      const state = typeof d.state === 'string' ? d.state : 'unknown'
      const trouble = state === 'close' ? connectionTroubleReason(d.statusReason) : null
      const number = typeof d.wuid === 'string' ? jidDigits(d.wuid) : null
      await db
        .from('evolution_config')
        .update({
          state: trouble === 'logged_out' ? 'logged_out' : ['open', 'connecting', 'close'].includes(state) ? state : 'unknown',
          last_event_at: now,
          ...(state === 'open' ? { qr_code: null, pairing_code: null } : {}),
          ...(number && state === 'open' ? { connected_number: number } : {}),
          ...(typeof d.profileName === 'string' && state === 'open' ? { profile_name: d.profileName } : {}),
        })
        .eq('account_id', accountId)
      await logEvolutionEvent(accountId, event, trouble ?? state, db)
      // Logged out / refused by WhatsApp: stop sending at once and tell the team.
      if (trouble) await pauseNumber(accountId, trouble, db)
    } else if (event === 'qrcode.updated') {
      const q = (body.data?.qrcode ?? body.data) as Record<string, unknown> | undefined
      const qr = typeof q?.base64 === 'string' ? q.base64 : null
      const code = typeof q?.pairingCode === 'string' ? q.pairingCode : null
      await db
        .from('evolution_config')
        .update({ qr_code: qr, ...(code ? { pairing_code: code } : {}), qr_updated_at: now, last_event_at: now, state: 'connecting' })
        .eq('account_id', accountId)
    } else if (event === 'messages.upsert' || event === 'messages.update') {
      after(async () => {
        try {
          await db.from('evolution_config').update({ last_event_at: now }).eq('account_id', accountId)
          const ctx = { db, accountId, requestUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin }
          const outcome = event === 'messages.update' ? await receiveUpdates(body.data, ctx) : await receiveUpsert(body.data, ctx)
          await logEvolutionEvent(accountId, event, outcome, db)
        } catch {
          await logEvolutionEvent(accountId, event, 'error', db)
        }
      })
    }
  } catch {
    await logEvolutionEvent(accountId, event, 'error', db)
  }
  return NextResponse.json({ ok: true })
}
