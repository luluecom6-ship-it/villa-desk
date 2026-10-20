import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountContext } from '@/lib/auth/account'
import { automationState } from './automation'
import { idStatus, STAY_FILTERS, matchesFilter } from './filters'
import type { StayWithGuests } from './types'

// Server-only helpers for the stays API routes.

/** Columns the dashboard needs from stay_guests (never ID image data). */
export const GUEST_COLUMNS =
  'id, role, full_name, is_adult, id_type, id_last4, id_verified_at, id_rejected_at, is_foreign, form_c_required'

/** Public guest-form link for a stay. Origin: NEXT_PUBLIC_SITE_URL, else the request's. */
export function stayFormUrl(requestUrl: string, token: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  const origin = configured || new URL(requestUrl).origin
  return `${origin}/stay/${token}`
}

/**
 * Phase 1 ships with one property per account (PDR section 2). Return its id,
 * creating it on first use. Callers must already have checked the admin role.
 */
export async function ensureProperty(ctx: AccountContext): Promise<string> {
  const { data: existing } = await ctx.supabase
    .from('properties')
    .select('id')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (existing && existing.length > 0) return existing[0].id as string

  const { data, error } = await ctx.supabase
    .from('properties')
    .insert({ account_id: ctx.accountId, name: ctx.account.name })
    .select('id')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create property')
  return data.id as string
}

/**
 * Link a stay to the upstream contacts row for its mobile number, creating the
 * contact if needed, so a returning guest shares one inbox conversation.
 * Best effort: a failure here must never block saving the stay.
 */
export async function linkContact(
  client: SupabaseClient,
  ctx: Pick<AccountContext, 'accountId' | 'userId'>,
  phone: string,
  name: string,
): Promise<string | null> {
  try {
    const { data: found } = await client
      .from('contacts')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('phone_normalized', phone)
      .limit(1)
    if (found && found.length > 0) return found[0].id as string

    const { data: created, error } = await client
      .from('contacts')
      .insert({ account_id: ctx.accountId, user_id: ctx.userId, phone, name })
      .select('id')
      .single()
    if (error || !created) {
      console.warn('[stays] contact link skipped:', error?.message)
      return null
    }
    return created.id as string
  } catch (err) {
    console.warn('[stays] contact link failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** True when a Postgres error is the "two live stays on one number" index. */
export function isLivePhoneConflict(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    error.code === '23505' &&
    (error.message ?? '').includes('uq_stays_live_phone')
  )
}

/**
 * A returning guest: their previous stay is still 'registered' or 'checked_in'
 * after its check-out time, which holds the number under uq_stays_live_phone.
 * Mark such finished stays checked out (history is kept, nothing deleted).
 * Returns how many were closed. Stays that are still running are untouched.
 */
export async function closeFinishedStays(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  exceptId?: string,
  now: Date = new Date(),
): Promise<number> {
  let q = db
    .from('stays')
    .update({ status: 'checked_out' })
    .eq('account_id', accountId)
    .eq('guest_phone', phone)
    .in('status', ['registered', 'checked_in'])
    .lt('checkout_at', now.toISOString())
  if (exceptId) q = q.neq('id', exceptId)
  const { data, error } = await q.select('id')
  if (error) return 0
  return data?.length ?? 0
}

/** Decorate a stay row with computed dashboard fields. */
export function decorateStay(
  stay: StayWithGuests,
  opts: { requestUrl: string; includeLink: boolean; now?: Date },
) {
  const { form_token, ...rest } = stay
  return {
    ...rest,
    automation: automationState(stay, opts.now),
    id_status: idStatus(stay),
    // The token is the guest's key to the form, so only roles that can send
    // the link (admin and above) receive it.
    ...(opts.includeLink
      ? { form_url: stayFormUrl(opts.requestUrl, form_token) }
      : {}),
  }
}

/** How many stays each filter chip would show. */
export function filterCounts(stays: StayWithGuests[], now: Date = new Date()) {
  const counts: Record<string, number> = {}
  for (const f of STAY_FILTERS) {
    counts[f] = stays.filter((s) => matchesFilter(s, f, now)).length
  }
  return counts
}
