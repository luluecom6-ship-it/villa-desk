// Shared types for the villa-desk "Stays" module (see CLAUDE.md and the PDR).
// These mirror migrations 047-051.

export const STAY_SOURCES = [
  'airbnb',
  'booking_com',
  'makemytrip',
  'goibibo',
  'direct',
  'other',
] as const
export type StaySource = (typeof STAY_SOURCES)[number]

export const STAY_STATUSES = [
  'draft',
  'registered',
  'checked_in',
  'checked_out',
  'cancelled',
  'sample',
] as const
export type StayStatus = (typeof STAY_STATUSES)[number]

export type FormStatus = 'pending' | 'submitted'

/** The slice of stay_guests the dashboard needs. No ID image data. */
export interface StayGuestSummary {
  id: string
  role: 'lead' | 'occupant'
  full_name: string
  is_adult: boolean
  id_type: string | null
  id_last4: string | null
  id_verified_at: string | null
  id_rejected_at: string | null
  is_foreign: boolean
  form_c_required: boolean
}

export interface StayRow {
  id: string
  account_id: string
  property_id: string
  contact_id: string | null
  stay_ref: string
  form_token: string
  guest_name: string
  guest_phone: string | null
  guest_email: string | null
  source: StaySource
  external_booking_ref: string | null
  status: StayStatus
  form_status: FormStatus
  form_submitted_at: string | null
  checkin_at: string
  checkout_at: string
  guests_count: number
  notes: string | null
  automation_paused: boolean
  automation_ready: boolean
  guest_arrived_at: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

/** `deposit_status` is only attached for owner/admin (caretakers never see deposit data). */
export type StayWithGuests = StayRow & { stay_guests?: StayGuestSummary[]; deposit_status?: string | null }

/** Why automation is off for a stay, in priority order. */
export type AutomationOffReason =
  | 'cancelled'
  | 'sample'
  | 'no_mobile'
  | 'paused'
  | 'closed'

export interface AutomationState {
  on: boolean
  reason: AutomationOffReason | null
}

export type IdStatus = 'none' | 'pending' | 'verified' | 'rejected'
