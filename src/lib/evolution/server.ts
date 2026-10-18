import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeBaseUrl, type EvolutionConn } from './client'

// Server-side helpers for the Evolution channel. The Evolution server address
// and global key are env vars; each account's instance token is stored
// encrypted in evolution_config (service role only).

export interface EvolutionConfigRow {
  account_id: string
  instance_name: string
  api_key: string
  webhook_secret: string
  state: 'open' | 'connecting' | 'close' | 'logged_out' | 'unknown'
  connected_number: string | null
  profile_name: string | null
  qr_code: string | null
  pairing_code: string | null
  qr_updated_at: string | null
  last_event_at: string | null
  warmup_started_at: string | null
  max_daily: number
  window_start_hour: number
  window_end_hour: number
  auto_pause: boolean
  paused_at: string | null
  paused_reason: string | null
  resumed_at: string | null
  created_by: string | null
}

export class EvolutionSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvolutionSetupError'
  }
}

/** The Evolution server this deployment talks to. Throws a plain message when not set up. */
export function evolutionServer(): { baseUrl: string; globalKey: string } {
  const baseUrl = normalizeBaseUrl(process.env.EVOLUTION_BASE_URL ?? '')
  const globalKey = (process.env.EVOLUTION_API_KEY ?? '').trim()
  if (!baseUrl || !globalKey) {
    throw new EvolutionSetupError('EVOLUTION_BASE_URL and EVOLUTION_API_KEY are not set on the server.')
  }
  return { baseUrl, globalKey }
}

export function evolutionSetupError(err: unknown): string | null {
  return err instanceof EvolutionSetupError ? err.message : null
}

export function connFromRow(row: Pick<EvolutionConfigRow, 'instance_name' | 'api_key'>): EvolutionConn {
  const { baseUrl } = evolutionServer()
  return { baseUrl, instance: row.instance_name, apiKey: decrypt(row.api_key) }
}

export async function loadEvolutionConfig(accountId: string, db: SupabaseClient = supabaseAdmin()): Promise<EvolutionConfigRow | null> {
  const { data, error } = await db.from('evolution_config').select('*').eq('account_id', accountId).maybeSingle()
  if (error) throw new Error(`evolution_config read failed: ${error.code ?? 'error'}`)
  return (data as EvolutionConfigRow | null) ?? null
}

/** Absolute webhook URL for this account (secret in the path; Evolution does not sign webhooks). */
export function webhookUrl(request: Request, secret: string): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  const origin = site || new URL(request.url).origin
  return `${origin}/api/evolution/webhook/${secret}`
}

/** Diagnostics: event name and a short outcome word. Never a payload, text or number. Never pruned. */
export async function logEvolutionEvent(accountId: string, event: string, outcome: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  const { error } = await db
    .from('evolution_event_log')
    .insert({ account_id: accountId, event: event.slice(0, 60), outcome: outcome.replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 80) })
  if (error) console.error('[evolution] event log failed:', error.code)
}

/** Property time zone for the safety window (default Asia/Kolkata). */
export async function propertyTimeZone(db: SupabaseClient, accountId: string): Promise<string> {
  const { data } = await db.from('properties').select('timezone').eq('account_id', accountId).limit(1)
  const tz = (data?.[0] as { timezone?: string } | undefined)?.timezone
  return tz || 'Asia/Kolkata'
}
