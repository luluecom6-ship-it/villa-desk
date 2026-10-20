import type { SupabaseClient } from '@supabase/supabase-js'
import { maskPhone } from './phone'

// Server helpers for the public guest form (/stay/<token>).
// Everything here runs with the service-role client, because the guest has no
// session. The 14-character token is the only credential.

export const FORM_TOKEN = /^[0-9a-f]{14}$/

export const FORM_BUCKET = 'stay-ids'

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

export interface FormStayRow {
  id: string
  account_id: string
  property_id: string
  stay_ref: string
  guest_name: string
  guest_phone: string | null
  status: string
  form_status: 'pending' | 'submitted'
  checkin_at: string
  checkout_at: string
  guests_count: number
  expected_arrival_time: string | null
  vehicle_number: string | null
  special_request: string | null
  purpose_of_visit: string | null
}

/**
 * Look up the stay a form token belongs to. Returns null for an unknown,
 * cancelled, sample or finished stay: the guest must not be able to tell
 * those apart (PDR 6.1).
 */
export async function findFormStay(
  admin: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<FormStayRow | null> {
  if (!FORM_TOKEN.test(token)) return null
  const { data, error } = await admin
    .from('stays')
    .select(
      'id, account_id, property_id, stay_ref, guest_name, guest_phone, status, form_status, checkin_at, checkout_at, guests_count, expected_arrival_time, vehicle_number, special_request, purpose_of_visit',
    )
    .eq('form_token', token)
    .maybeSingle()
  if (error || !data) return null
  const stay = data as FormStayRow
  if (['cancelled', 'sample', 'checked_out'].includes(stay.status)) return null
  if (new Date(stay.checkout_at) < now) return null
  return stay
}

/** Once submitted, the form can be edited only until check-in (PDR 6.1). */
export function isFormReadOnly(
  stay: FormStayRow,
  now: Date = new Date(),
  hasRejectedId = false,
): boolean {
  // A guest whose ID was rejected can always upload it again (migration 063).
  if (hasRejectedId) return false
  return (
    stay.form_status === 'submitted' &&
    (stay.status === 'checked_in' || new Date(stay.checkin_at) <= now)
  )
}

/** True while staff have rejected at least one guest's ID on this stay. */
export async function stayHasRejectedId(admin: SupabaseClient, stayId: string): Promise<boolean> {
  const { data } = await admin
    .from('stay_guests')
    .select('id')
    .eq('stay_id', stayId)
    .not('id_rejected_at', 'is', null)
    .limit(1)
  return !!data && data.length > 0
}

export interface LatestRules {
  id: string
  version: number
  title: string
  body: string
}

export async function latestHouseRules(
  admin: SupabaseClient,
  accountId: string,
): Promise<LatestRules | null> {
  const { data } = await admin
    .from('house_rules_versions')
    .select('id, version, title, body')
    .eq('account_id', accountId)
    .order('version', { ascending: false })
    .limit(1)
  return data && data.length > 0 ? (data[0] as LatestRules) : null
}

/** Map an RPC failure ("stay_form:<code>") to an HTTP status and message key. */
export function mapSubmitError(message: string | undefined): {
  status: number
  key: string
} {
  const code = /stay_form:([a-z_]+)/.exec(message ?? '')?.[1]
  switch (code) {
    case 'not_found':
      return { status: 404, key: 'notValid' }
    case 'closed':
      return { status: 409, key: 'formClosed' }
    case 'no_rules':
      return { status: 503, key: 'notOpenYet' }
    case 'rules_changed':
      return { status: 409, key: 'rulesChanged' }
    case 'signature_required':
      return { status: 400, key: 'signatureRequired' }
    case 'id_required':
      return { status: 400, key: 'idPhotoRequired' }
    case 'name_required':
      return { status: 400, key: 'required' }
    case 'bad_guest':
    case 'bad_path':
      return { status: 400, key: 'badRequest' }
    default:
      return { status: 500, key: 'saveFailed' }
  }
}

export { maskPhone }
