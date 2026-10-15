import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutomationState, StayRow } from './types'
import { isValidStayPhone } from './phone'

/**
 * PDR 4.2: a stay stays on the allow-list until checkout + 7 days, so the
 * review and deposit messages can still go out after the guest leaves.
 */
export const AUTOMATION_CLOSE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

type AutomationFields = Pick<
  StayRow,
  'status' | 'guest_phone' | 'automation_paused' | 'checkout_at' | 'stay_ref'
>

/**
 * Is automation on for this stay, and if not, why? Used by the dashboard badge
 * ("Off: Add a mobile number"). The database's `automation_ready` column
 * covers everything except the time-based close date, which is added here.
 */
export function automationState(
  stay: AutomationFields,
  now: Date = new Date(),
): AutomationState {
  if (stay.status === 'cancelled') return { on: false, reason: 'cancelled' }
  if (stay.status === 'sample') return { on: false, reason: 'sample' }
  if (!stay.guest_phone || !isValidStayPhone(stay.guest_phone)) {
    return { on: false, reason: 'no_mobile' }
  }
  if (stay.status === 'draft') return { on: false, reason: 'no_mobile' }
  if (stay.automation_paused) return { on: false, reason: 'paused' }
  const closesAt =
    new Date(stay.checkout_at).getTime() + AUTOMATION_CLOSE_DAYS * DAY_MS
  if (now.getTime() > closesAt) return { on: false, reason: 'closed' }
  return { on: true, reason: null }
}

export interface AllowedStay {
  id: string
  stay_ref: string
}

/**
 * The allow-list lookup behind PDR section 4. Returns the stay a number
 * belongs to, or null when automation must not touch it.
 *
 * Matching is exact on the stored digits-with-country-code form. This is
 * deliberately NOT the fuzzy "last 8 digits" matching used elsewhere in the
 * app (phonesMatch): a gate that errs towards sending to a wrong person is
 * worse than one that errs towards silence.
 *
 * `client` must be a service-role client: this runs from the scheduler, the
 * send function and webhooks, none of which have a user session.
 */
export async function findAutomationStay(
  client: SupabaseClient,
  accountId: string,
  phone: string,
  now: Date = new Date(),
): Promise<AllowedStay | null> {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!isValidStayPhone(digits)) return null

  const earliestCheckout = new Date(
    now.getTime() - AUTOMATION_CLOSE_DAYS * DAY_MS,
  ).toISOString()

  const { data, error } = await client
    .from('stays')
    .select('id, stay_ref')
    .eq('account_id', accountId)
    .eq('guest_phone', digits)
    .eq('automation_ready', true)
    .gte('checkout_at', earliestCheckout)
    .order('checkin_at', { ascending: false })
    .limit(1)

  // Fail closed: if the lookup fails, nothing is allowed.
  if (error || !data || data.length === 0) return null
  return data[0] as AllowedStay
}

/** isAutomationAllowed(accountId, phone) from the PDR. */
export async function isAutomationAllowed(
  client: SupabaseClient,
  accountId: string,
  phone: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await findAutomationStay(client, accountId, phone, now)) !== null
}
