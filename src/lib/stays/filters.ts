import type { IdStatus, StayWithGuests } from './types'
import { istDayBounds } from './time'

// Dashboard filters (PDR 5.1). A villa has a handful of live stays, so the
// list route fetches the account's stays once and filters here: one pure,
// testable definition shared by the API and (later) the Today view.
//
// "Deposit to refund" needs the deposit status, which the list route attaches for owner/admin only.

export const STAY_FILTERS = [
  'all',
  'arrivals_today',
  'departures_today',
  'in_house',
  'upcoming',
  'form_pending',
  'id_pending',
  'deposit_refund',
  'cancelled',
] as const
export type StayFilter = (typeof STAY_FILTERS)[number]

export function isStayFilter(v: unknown): v is StayFilter {
  return typeof v === 'string' && (STAY_FILTERS as readonly string[]).includes(v)
}

const DEAD = new Set(['cancelled', 'sample'])

/** Overall ID state for a stay, from its guests' review fields. */
export function idStatus(stay: StayWithGuests): IdStatus {
  const adults = (stay.stay_guests ?? []).filter((g) => g.is_adult)
  if (adults.length === 0) return 'none'
  if (adults.some((g) => g.id_rejected_at)) return 'rejected'
  if (adults.every((g) => g.id_verified_at)) return 'verified'
  return 'pending'
}

export function matchesFilter(
  stay: StayWithGuests,
  filter: StayFilter,
  now: Date = new Date(),
): boolean {
  const { start, end } = istDayBounds(now)
  const checkin = new Date(stay.checkin_at)
  const checkout = new Date(stay.checkout_at)
  const live = !DEAD.has(stay.status)

  switch (filter) {
    case 'all':
      // Default view: cancelled, sample and closed stays are hidden, not deleted.
      return live && !stay.closed_at
    case 'arrivals_today':
      return live && checkin >= start && checkin < end
    case 'departures_today':
      return live && checkout >= start && checkout < end
    case 'in_house':
      return (
        stay.status === 'checked_in' ||
        (stay.status === 'registered' && checkin <= now && now < checkout)
      )
    case 'upcoming':
      return (stay.status === 'draft' || stay.status === 'registered') && checkin > now
    case 'form_pending':
      return live && stay.status !== 'checked_out' && stay.form_status === 'pending'
    case 'id_pending': {
      if (!live || stay.status === 'checked_out') return false
      const s = idStatus(stay)
      return s === 'none' || s === 'pending' || s === 'rejected'
    }
    case 'deposit_refund':
      return stay.deposit_status === 'refund_due' && stay.status !== 'cancelled'
    case 'cancelled':
      return stay.status === 'cancelled'
  }
}

/**
 * Free-text search over name, mobile digits, Stay Reference and the platform
 * booking reference. Search looks at every stay, including cancelled ones.
 */
export function matchesSearch(stay: StayWithGuests, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  return (
    stay.guest_name.toLowerCase().includes(q) ||
    stay.stay_ref.toLowerCase().includes(q) ||
    (stay.external_booking_ref ?? '').toLowerCase().includes(q) ||
    (digits.length >= 3 && (stay.guest_phone ?? '').includes(digits))
  )
}

export function filterStays(
  stays: StayWithGuests[],
  filter: StayFilter,
  query: string,
  now: Date = new Date(),
): StayWithGuests[] {
  const searching = query.trim().length > 0
  return stays.filter((s) =>
    searching ? matchesSearch(s, query) : matchesFilter(s, filter, now),
  )
}
