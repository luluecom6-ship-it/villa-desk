// Validation for the public guest form (PDR 6.2 / 6.4). Pure, so the browser
// and the server run exactly the same rules.
//
// Error values are keys under the "GuestForm.errors" message namespace.
// Error paths look like "lead.full_name", "occupants.1.age", "acceptance.typed_name",
// "documents.lead" (a missing front-side ID for that person).

export const ID_TYPES = ['aadhaar', 'passport', 'driving_licence', 'voter_id', 'other'] as const
export type IdType = (typeof ID_TYPES)[number]

export const PURPOSES = ['leisure', 'business', 'family', 'event', 'other'] as const

export const MAX_OCCUPANTS = 12
export const ADULT_AGE = 18

export type GuestFormErrorKey =
  | 'required'
  | 'tooLong'
  | 'invalidEmail'
  | 'invalidLast4'
  | 'invalidTime'
  | 'invalidDate'
  | 'invalidAge'
  | 'tooManyGuests'
  | 'idTypeRequired'
  | 'passportRequired'
  | 'idPhotoRequired'
  | 'acceptRules'
  | 'signatureRequired'
  | 'badRequest'

export interface GuestFormLead {
  full_name: string
  mobile: string
  email: string
  is_foreign: boolean
  nationality: string
  address: string
  id_type: string
  id_last4: string
  visa_type: string
  visa_expiry: string
  arrived_in_india_on: string
}

export interface GuestFormOccupant {
  /** Stable key chosen by the browser; file parts are named after it. */
  client_key: string
  /** Present when the person was saved by an earlier submit. */
  id?: string
  full_name: string
  age: string | number
  id_type: string
  id_last4: string
}

export interface GuestFormInput {
  lead: GuestFormLead
  arrival: {
    expected_arrival_time: string
    vehicle_number: string
    special_request: string
    purpose_of_visit: string
  }
  occupants: GuestFormOccupant[]
  /** Which person/side each uploaded file part belongs to. */
  documents: Array<{ guest_key: string; side: 'front' | 'back' }>
  acceptance: { accepted: boolean; typed_name: string; rules_version_id: string }
}

export interface ParsedGuestForm {
  lead: Record<string, unknown>
  arrival: Record<string, unknown>
  occupants: Array<Record<string, unknown>>
  documents: Array<{ guest_key: string; side: 'front' | 'back' }>
  acceptance: { rules_version_id: string; typed_name: string }
}

export type GuestFormResult =
  | { ok: true; value: ParsedGuestForm }
  | { ok: false; errors: Record<string, GuestFormErrorKey> }

export interface ParseContext {
  /** The stay already has a signed acceptance (form is being edited). */
  alreadySigned: boolean
  /** Guest keys that already have a live front-side ID file on record. */
  existingFronts: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9_-]{1,24}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LAST4 = /^[0-9A-Za-z]{4}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function isAdultAge(age: number): boolean {
  return age >= ADULT_AGE
}

export function parseGuestForm(raw: unknown, ctx: ParseContext): GuestFormResult {
  const errors: Record<string, GuestFormErrorKey> = {}
  if (!raw || typeof raw !== 'object') return { ok: false, errors: { form: 'badRequest' } }
  const b = raw as Record<string, unknown>
  const leadIn = (b.lead && typeof b.lead === 'object' ? b.lead : {}) as Record<string, unknown>
  const arrIn = (b.arrival && typeof b.arrival === 'object' ? b.arrival : {}) as Record<string, unknown>
  const accIn = (b.acceptance && typeof b.acceptance === 'object' ? b.acceptance : {}) as Record<string, unknown>

  // ---- Lead guest -------------------------------------------------------
  const full_name = s(leadIn.full_name)
  if (!full_name) errors['lead.full_name'] = 'required'
  else if (full_name.length > 120) errors['lead.full_name'] = 'tooLong'

  const email = s(leadIn.email)
  if (email && !EMAIL.test(email)) errors['lead.email'] = 'invalidEmail'
  else if (email.length > 160) errors['lead.email'] = 'tooLong'

  const is_foreign = leadIn.is_foreign === true
  let nationality = s(leadIn.nationality)
  if (!is_foreign) nationality = 'Indian'
  else if (!nationality) errors['lead.nationality'] = 'required'
  else if (nationality.length > 60) errors['lead.nationality'] = 'tooLong'

  const address = s(leadIn.address)
  if (address.length < 5) errors['lead.address'] = 'required'
  else if (address.length > 300) errors['lead.address'] = 'tooLong'

  const leadIdType = s(leadIn.id_type)
  if (!(ID_TYPES as readonly string[]).includes(leadIdType)) errors['lead.id_type'] = 'idTypeRequired'
  else if (is_foreign && leadIdType !== 'passport') errors['lead.id_type'] = 'passportRequired'

  const leadLast4 = s(leadIn.id_last4)
  if (!LAST4.test(leadLast4)) errors['lead.id_last4'] = 'invalidLast4'

  const visa_expiry = s(leadIn.visa_expiry)
  const arrived = s(leadIn.arrived_in_india_on)
  if (is_foreign) {
    if (visa_expiry && !DATE.test(visa_expiry)) errors['lead.visa_expiry'] = 'invalidDate'
    if (arrived && !DATE.test(arrived)) errors['lead.arrived_in_india_on'] = 'invalidDate'
  }
  const visa_type = s(leadIn.visa_type)
  if (visa_type.length > 60) errors['lead.visa_type'] = 'tooLong'

  // ---- Arrival ----------------------------------------------------------
  const eta = s(arrIn.expected_arrival_time)
  if (eta && !TIME.test(eta)) errors['arrival.expected_arrival_time'] = 'invalidTime'
  const vehicle = s(arrIn.vehicle_number)
  if (vehicle.length > 20) errors['arrival.vehicle_number'] = 'tooLong'
  const request = s(arrIn.special_request)
  if (request.length > 500) errors['arrival.special_request'] = 'tooLong'
  const purpose = s(arrIn.purpose_of_visit)
  const purposeOk = !purpose || (PURPOSES as readonly string[]).includes(purpose)
  if (!purposeOk) errors['arrival.purpose_of_visit'] = 'badRequest'

  // ---- Occupants --------------------------------------------------------
  const occIn = Array.isArray(b.occupants) ? b.occupants : []
  if (occIn.length > MAX_OCCUPANTS) errors.occupants = 'tooManyGuests'

  const keys = new Set<string>(['lead'])
  const adultKeys = new Set<string>(['lead'])
  const occupants: Array<Record<string, unknown>> = []

  occIn.slice(0, MAX_OCCUPANTS).forEach((item, i) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const p = `occupants.${i}`
    const client_key = s(o.client_key)
    if (!KEY.test(client_key) || keys.has(client_key)) {
      errors[`${p}.client_key`] = 'badRequest'
      return
    }
    keys.add(client_key)

    const id = s(o.id)
    if (id && !UUID.test(id)) errors[`${p}.id`] = 'badRequest'

    const name = s(o.full_name)
    if (!name) errors[`${p}.full_name`] = 'required'
    else if (name.length > 120) errors[`${p}.full_name`] = 'tooLong'

    const ageText = typeof o.age === 'number' ? String(o.age) : s(o.age)
    const age = Number(ageText)
    if (ageText === '' || !Number.isInteger(age) || age < 0 || age > 120) errors[`${p}.age`] = 'invalidAge'

    const adult = Number.isInteger(age) && ageText !== '' && isAdultAge(age)
    let id_type = ''
    let id_last4 = ''
    if (adult) {
      adultKeys.add(client_key)
      id_type = s(o.id_type)
      if (!(ID_TYPES as readonly string[]).includes(id_type)) errors[`${p}.id_type`] = 'idTypeRequired'
      id_last4 = s(o.id_last4)
      if (!LAST4.test(id_last4)) errors[`${p}.id_last4`] = 'invalidLast4'
    }

    occupants.push({
      ...(id ? { id } : {}),
      client_key,
      full_name: name,
      age: ageText === '' ? null : age,
      is_adult: adult,
      id_type,
      id_last4,
    })
  })

  // ---- Documents --------------------------------------------------------
  const docIn = Array.isArray(b.documents) ? b.documents : []
  const documents: Array<{ guest_key: string; side: 'front' | 'back' }> = []
  const seen = new Set<string>()
  docIn.forEach((item, i) => {
    const d = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const guest_key = s(d.guest_key)
    const side = d.side === 'back' ? 'back' : d.side === 'front' ? 'front' : null
    const id = `${guest_key}:${side}`
    if (!side || !adultKeys.has(guest_key) || seen.has(id)) {
      errors[`documents.${i}`] = 'badRequest'
      return
    }
    seen.add(id)
    documents.push({ guest_key, side })
  })

  // Every adult needs a front-side ID photo: newly attached or already on file.
  for (const key of adultKeys) {
    const hasNew = seen.has(`${key}:front`)
    if (!hasNew && !ctx.existingFronts.includes(key)) errors[`documents.${key}`] = 'idPhotoRequired'
  }

  // ---- Acceptance -------------------------------------------------------
  const rules_version_id = s(accIn.rules_version_id)
  const typed_name = s(accIn.typed_name)
  if (!ctx.alreadySigned) {
    if (accIn.accepted !== true) errors['acceptance.accepted'] = 'acceptRules'
    if (typed_name.length < 2) errors['acceptance.typed_name'] = 'signatureRequired'
    else if (typed_name.length > 120) errors['acceptance.typed_name'] = 'tooLong'
    if (!UUID.test(rules_version_id)) errors['acceptance.rules_version_id'] = 'badRequest'
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      lead: {
        full_name,
        mobile: s(leadIn.mobile),
        email,
        is_foreign,
        nationality,
        address,
        id_type: leadIdType,
        id_last4: leadLast4,
        visa_type: is_foreign ? visa_type : '',
        visa_expiry: is_foreign ? visa_expiry : '',
        arrived_in_india_on: is_foreign ? arrived : '',
      },
      arrival: {
        expected_arrival_time: eta,
        vehicle_number: vehicle,
        special_request: request,
        purpose_of_visit: purpose,
      },
      occupants,
      documents,
      acceptance: { rules_version_id, typed_name },
    },
  }
}
