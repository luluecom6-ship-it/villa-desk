import { STAY_SOURCES, type StaySource } from './types'
import { DEFAULT_COUNTRY_CODE, normalizeStayPhone } from './phone'
import { parseStayDateTime } from './time'

// Hand-rolled validation (the repo has no schema library). Errors are keys
// under the "Stays.errors" message namespace, so the API can localise them.

export type StayErrorKey =
  | 'nameRequired'
  | 'nameTooLong'
  | 'invalidPhone'
  | 'invalidEmail'
  | 'checkinInvalid'
  | 'checkoutInvalid'
  | 'checkoutBeforeCheckin'
  | 'guestsInvalid'
  | 'sourceInvalid'
  | 'refTooLong'
  | 'notesTooLong'
  | 'nothingToUpdate'

export interface StayInput {
  guest_name: string
  guest_phone: string | null
  guest_email: string | null
  source: StaySource
  external_booking_ref: string | null
  checkin_at: string
  checkout_at: string
  guests_count: number
  notes: string | null
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Partial<Record<string, StayErrorKey>> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v.trim() : undefined
}

/** Fields accepted by POST /api/stays. */
export function parseCreateStay(body: unknown): ValidationResult<StayInput> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const errors: Partial<Record<string, StayErrorKey>> = {}

  const guest_name = str(b.guest_name) ?? ''
  if (!guest_name) errors.guest_name = 'nameRequired'
  else if (guest_name.length > 120) errors.guest_name = 'nameTooLong'

  const countryCode = str(b.country_code)?.replace(/\D/g, '') || DEFAULT_COUNTRY_CODE
  const phoneResult = normalizeStayPhone(str(b.guest_phone), countryCode)
  if (phoneResult.error) errors.guest_phone = 'invalidPhone'

  const email = str(b.guest_email) || null
  if (email && !EMAIL.test(email)) errors.guest_email = 'invalidEmail'

  const checkin = parseStayDateTime(b.checkin_at)
  const checkout = parseStayDateTime(b.checkout_at)
  if (!checkin) errors.checkin_at = 'checkinInvalid'
  if (!checkout) errors.checkout_at = 'checkoutInvalid'
  if (checkin && checkout && checkout <= checkin) {
    errors.checkout_at = 'checkoutBeforeCheckin'
  }

  const rawGuests = b.guests_count === undefined || b.guests_count === '' ? 1 : Number(b.guests_count)
  if (!Number.isInteger(rawGuests) || rawGuests < 1 || rawGuests > 30) {
    errors.guests_count = 'guestsInvalid'
  }

  const source = (str(b.source) ?? 'direct') as StaySource
  if (!STAY_SOURCES.includes(source)) errors.source = 'sourceInvalid'

  const ref = str(b.external_booking_ref) || null
  if (ref && ref.length > 100) errors.external_booking_ref = 'refTooLong'

  const notes = str(b.notes) || null
  if (notes && notes.length > 2000) errors.notes = 'notesTooLong'

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      guest_name,
      guest_phone: phoneResult.phone,
      guest_email: email,
      source,
      external_booking_ref: ref,
      checkin_at: checkin!.toISOString(),
      checkout_at: checkout!.toISOString(),
      guests_count: rawGuests,
      notes,
    },
  }
}

export type StayPatch = Partial<StayInput> & {
  automation_paused?: boolean
  status?: 'cancelled'
}

/**
 * Fields accepted by PATCH /api/stays/[id]. Every field is optional, but at
 * least one must be present. `status` only accepts "cancelled": other status
 * changes happen through the registration flow, never by hand. There is
 * deliberately no way to "un-cancel" or delete from here.
 */
export function parsePatchStay(body: unknown): ValidationResult<StayPatch> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const errors: Partial<Record<string, StayErrorKey>> = {}
  const patch: StayPatch = {}

  if ('guest_name' in b) {
    const v = str(b.guest_name) ?? ''
    if (!v) errors.guest_name = 'nameRequired'
    else if (v.length > 120) errors.guest_name = 'nameTooLong'
    else patch.guest_name = v
  }

  if ('guest_phone' in b) {
    const countryCode = str(b.country_code)?.replace(/\D/g, '') || DEFAULT_COUNTRY_CODE
    const r = normalizeStayPhone(str(b.guest_phone), countryCode)
    if (r.error) errors.guest_phone = 'invalidPhone'
    else patch.guest_phone = r.phone // null removes the number
  }

  if ('guest_email' in b) {
    const v = str(b.guest_email) || null
    if (v && !EMAIL.test(v)) errors.guest_email = 'invalidEmail'
    else patch.guest_email = v
  }

  if ('source' in b) {
    const v = str(b.source) as StaySource
    if (!STAY_SOURCES.includes(v)) errors.source = 'sourceInvalid'
    else patch.source = v
  }

  if ('external_booking_ref' in b) {
    const v = str(b.external_booking_ref) || null
    if (v && v.length > 100) errors.external_booking_ref = 'refTooLong'
    else patch.external_booking_ref = v
  }

  if ('checkin_at' in b) {
    const d = parseStayDateTime(b.checkin_at)
    if (!d) errors.checkin_at = 'checkinInvalid'
    else patch.checkin_at = d.toISOString()
  }
  if ('checkout_at' in b) {
    const d = parseStayDateTime(b.checkout_at)
    if (!d) errors.checkout_at = 'checkoutInvalid'
    else patch.checkout_at = d.toISOString()
  }
  if (patch.checkin_at && patch.checkout_at && patch.checkout_at <= patch.checkin_at) {
    errors.checkout_at = 'checkoutBeforeCheckin'
  }

  if ('guests_count' in b) {
    const n = Number(b.guests_count)
    if (!Number.isInteger(n) || n < 1 || n > 30) errors.guests_count = 'guestsInvalid'
    else patch.guests_count = n
  }

  if ('notes' in b) {
    const v = str(b.notes) || null
    if (v && v.length > 2000) errors.notes = 'notesTooLong'
    else patch.notes = v
  }

  if ('automation_paused' in b) {
    if (typeof b.automation_paused === 'boolean') patch.automation_paused = b.automation_paused
  }

  if (b.status === 'cancelled') patch.status = 'cancelled'

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (Object.keys(patch).length === 0) {
    return { ok: false, errors: { _form: 'nothingToUpdate' } }
  }
  return { ok: true, value: patch }
}
