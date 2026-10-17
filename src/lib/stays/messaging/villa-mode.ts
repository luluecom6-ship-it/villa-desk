import type { SupabaseClient } from '@supabase/supabase-js'
import { findAutomationStay } from '../automation'
import { logStayMessage } from './send'

// "Villa mode" (PDR 4.2): while it is on for an account, upstream automations,
// flows and AI auto-replies only reach numbers that are on the stay allow-list.
// An account with no property record is not a villa account and is untouched.
// If the lookup fails we fail closed for villa accounts' sake: block.

export async function villaModeOn(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data, error } = await db
    .from('properties')
    .select('id')
    .eq('account_id', accountId)
    .eq('villa_mode', true)
    .limit(1)
  if (error) return true
  return !!data && data.length > 0
}

/** May an upstream automation / flow / AI reply go to this number? */
export async function villaAllowsAutomation(
  db: SupabaseClient,
  accountId: string,
  phone: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!(await villaModeOn(db, accountId))) return true
  if (!phone) return false
  return (await findAutomationStay(db, accountId, phone, now)) !== null
}

export class VillaBlockedError extends Error {
  readonly code = 'villa_blocked'
  constructor() {
    super('Not sent: this number is not on a registered, active stay (villa mode).')
    this.name = 'VillaBlockedError'
  }
}

/**
 * Call right before an upstream automation / flow / AI reply sends to a guest.
 * Throws (after logging blocked_not_registered) when villa mode is on and the
 * number is not on the allow-list. Manual messages never call this.
 */
export async function assertVillaSendAllowed(
  db: SupabaseClient,
  accountId: string,
  phone: string | null | undefined,
  source: string,
): Promise<void> {
  if (await villaAllowsAutomation(db, accountId, phone)) return
  await logStayMessage(db, {
    accountId,
    stayId: null,
    messageKey: `upstream_${source}`,
    outcome: 'blocked_not_registered',
    reason: 'villa_mode',
    phone: phone ?? null,
  })
  throw new VillaBlockedError()
}
