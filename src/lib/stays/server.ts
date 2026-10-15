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
