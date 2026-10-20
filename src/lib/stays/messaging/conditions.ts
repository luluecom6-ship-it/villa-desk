import type { MessageKey } from './schedule'

// Per-message conditions (PDR 7.1), judged at send time on current data.
//
//   send   conditions hold: send it now
//   wait   not true yet but may become true: leave it queued, look again
//   skip   will never be needed (e.g. the form was already submitted)
//
// A "wait" that outlives its `expiresAt` becomes a skip, so nothing lingers.

export type Verdict = 'send' | 'wait' | 'skip'

export interface ConditionStay {
  status: string
  form_status: string
  checkin_at: string | Date
  checkout_at: string | Date
}

export interface ConditionGuest {
  is_adult: boolean
  id_verified_at: string | null
}

const HOUR_MS = 60 * 60 * 1000

/** The guest has arrived: marked checked in, or past check-in on a live stay. */
export function isInHouse(stay: ConditionStay, now: Date): boolean {
  if (stay.status === 'checked_in') return true
  if (stay.status !== 'registered') return false
  return now >= new Date(stay.checkin_at) && now < new Date(stay.checkout_at)
}

/** Every adult has a verified ID (and there is at least one adult). */
export function allAdultIdsVerified(guests: ConditionGuest[]): boolean {
  const adults = guests.filter((g) => g.is_adult)
  return adults.length > 0 && adults.every((g) => !!g.id_verified_at)
}

export interface Judgement {
  verdict: Verdict
  reason: string
}

export function judge(
  key: MessageKey,
  stay: ConditionStay,
  guests: ConditionGuest[],
  now: Date,
): Judgement {
  const checkin = new Date(stay.checkin_at)
  const checkout = new Date(stay.checkout_at)
  const formDone = stay.form_status === 'submitted'

  switch (key) {
    case 'form_link':
      // The first form link always goes out on registration, even for a same-day or
      // already-started stay (the guest still has to fill the form); only a finished stay skips it.
      if (formDone) return { verdict: 'skip', reason: 'form_submitted' }
      if (now >= checkout) return { verdict: 'skip', reason: 'stay_over' }
      return { verdict: 'send', reason: 'form_pending' }

    case 'form_reminder_3d':
    case 'form_reminder_2d':
    case 'form_reminder_1d':
      if (formDone) return { verdict: 'skip', reason: 'form_submitted' }
      if (now >= checkin) return { verdict: 'skip', reason: 'stay_started' }
      return { verdict: 'send', reason: 'form_pending' }

    case 'id_alert_staff':
      if (allAdultIdsVerified(guests)) return { verdict: 'skip', reason: 'ids_verified' }
      if (now >= checkout) return { verdict: 'skip', reason: 'stay_over' }
      return { verdict: 'send', reason: 'ids_unverified' }

    case 'arrival_info':
      if (now >= checkin) return { verdict: 'skip', reason: 'stay_started' }
      return formDone
        ? { verdict: 'send', reason: 'form_submitted' }
        : { verdict: 'wait', reason: 'form_not_submitted' }

    case 'access_details':
      if (now >= checkout) return { verdict: 'skip', reason: 'stay_over' }
      return allAdultIdsVerified(guests)
        ? { verdict: 'send', reason: 'ids_verified' }
        : { verdict: 'wait', reason: 'ids_not_verified' }

    case 'owner_alert':
      if (formDone) return { verdict: 'skip', reason: 'form_submitted' }
      if (now >= checkout) return { verdict: 'skip', reason: 'stay_over' }
      return { verdict: 'send', reason: 'form_incomplete' }

    case 'arrival_check':
      if (now.getTime() >= checkin.getTime() + 8 * HOUR_MS && !isInHouse(stay, now)) {
        return { verdict: 'skip', reason: 'not_arrived' }
      }
      return isInHouse(stay, now)
        ? { verdict: 'send', reason: 'in_house' }
        : { verdict: 'wait', reason: 'not_arrived' }

    case 'checkout_reminder':
      if (now >= checkout) return { verdict: 'skip', reason: 'stay_over' }
      return isInHouse(stay, now)
        ? { verdict: 'send', reason: 'in_house' }
        : { verdict: 'wait', reason: 'not_in_house' }

    case 'review_request':
      if (stay.status === 'checked_out' || now >= checkout) {
        return { verdict: 'send', reason: 'checked_out' }
      }
      return { verdict: 'wait', reason: 'not_checked_out' }
  }
}
