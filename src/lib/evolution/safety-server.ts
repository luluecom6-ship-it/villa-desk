import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { notifyStaff } from '@/lib/stays/messaging/notify'
import { phoneTail } from '@/lib/stays/messaging/send'
import { dailyLimit, dayKeyIn, inWindow, shouldAutoPause, type GateCode } from './safety'
import { loadEvolutionConfig, propertyTimeZone, type EvolutionConfigRow } from './server'

export type SendKind = 'scheduled' | 'reply' | 'test'

export interface Gate {
  code: GateCode
}

/**
 * May a send of this kind go out now? null = yes.
 *  - every kind: the number must be linked, connected and not paused
 *  - scheduled (business-initiated): also inside the sending hours and under today's limit
 *  - reply / test: no hours or count limit (a guest wrote to us first)
 */
export async function sendGate(
  accountId: string,
  kind: SendKind,
  opts: { db?: SupabaseClient; now?: Date; cfg?: EvolutionConfigRow | null } = {},
): Promise<Gate | null> {
  const db = opts.db ?? supabaseAdmin()
  const now = opts.now ?? new Date()
  const cfg = opts.cfg === undefined ? await loadEvolutionConfig(accountId, db) : opts.cfg
  if (!cfg) return { code: 'not_configured' }
  if (cfg.paused_at) return { code: 'paused' }
  if (cfg.state !== 'open') return { code: 'disconnected' }
  if (kind !== 'scheduled') return null

  const tz = await propertyTimeZone(db, accountId)
  if (!inWindow(tz, now, cfg.window_start_hour, cfg.window_end_hour)) return { code: 'outside_hours' }

  const limit = dailyLimit(cfg.warmup_started_at ? new Date(cfg.warmup_started_at) : null, now, cfg.max_daily)
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString()
  const { data, error } = await db
    .from('evolution_send_log')
    .select('sent_at')
    .eq('account_id', accountId)
    .eq('kind', 'scheduled')
    .eq('ok', true)
    .gte('sent_at', since)
  if (error) return { code: 'daily_limit' } // fail closed
  const today = dayKeyIn(tz, now)
  const sentToday = (data ?? []).filter((r: { sent_at: string }) => dayKeyIn(tz, new Date(r.sent_at)) === today).length
  return sentToday >= limit ? { code: 'daily_limit' } : null
}

export async function recordSend(
  accountId: string,
  r: { ok: boolean; kind: SendKind; phone?: string | null; errorCode?: string | null },
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  const { error } = await db.from('evolution_send_log').insert({
    account_id: accountId,
    ok: r.ok,
    kind: r.kind,
    phone_tail: r.phone ? phoneTail(r.phone) || null : null,
    error_code: r.errorCode ? r.errorCode.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) : null,
  })
  if (error) console.error('[evolution] send log failed:', error.code)
  if (r.ok) {
    // The first real send starts the warm-up clock.
    await db.from('evolution_config').update({ warmup_started_at: new Date().toISOString() }).eq('account_id', accountId).is('warmup_started_at', null)
  }
}

/** Pause sending and tell the team. Safe to call repeatedly. */
export async function pauseNumber(accountId: string, reason: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  const { data } = await db
    .from('evolution_config')
    .update({ paused_at: new Date().toISOString(), paused_reason: reason })
    .eq('account_id', accountId)
    .is('paused_at', null)
    .select('account_id')
  if (data && data.length > 0) {
    await notifyStaff(
      db,
      accountId,
      'WhatsApp number paused',
      `Sending through the villa WhatsApp number was paused (${reason}). Messages stay queued. Open Settings → WhatsApp link to check and resume.`,
    ).catch(() => undefined)
  }
}

export async function resumeNumber(accountId: string, userId: string | null, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  await db
    .from('evolution_config')
    .update({ paused_at: null, paused_reason: null, resumed_at: new Date().toISOString(), updated_by: userId, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
}

/** After a failed send: pause when 4 of the last 5 sends since the last resume failed. */
export async function checkHealth(accountId: string, db: SupabaseClient = supabaseAdmin()): Promise<boolean> {
  const cfg = await loadEvolutionConfig(accountId, db)
  if (!cfg || !cfg.auto_pause || cfg.paused_at) return false
  let q = db.from('evolution_send_log').select('ok').eq('account_id', accountId).order('sent_at', { ascending: false }).limit(5)
  if (cfg.resumed_at) q = q.gt('sent_at', cfg.resumed_at)
  const { data } = await q
  if (!shouldAutoPause((data ?? []) as { ok: boolean }[])) return false
  await pauseNumber(accountId, 'too_many_failures', db)
  return true
}
