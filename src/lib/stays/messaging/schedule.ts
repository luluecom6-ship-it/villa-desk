import { istDayAt, istHour } from '../time'

// The message schedule (PDR 7.1). All times are Asia/Kolkata. A message that
// falls due outside 09:00 to 20:00 waits until 09:00 (guest messages only:
// staff alerts are internal and are not held back).

export const SEND_WINDOW_START_HOUR = 9
export const SEND_WINDOW_END_HOUR = 20

export const MESSAGE_KEYS = [
  'form_link',
  'form_reminder_3d',
  'form_reminder_2d',
  'form_reminder_1d',
  'id_alert_staff',
  'arrival_info',
  'access_details',
  'owner_alert',
  'arrival_check',
  'checkout_reminder',
  'review_request',
] as const
export type MessageKey = (typeof MESSAGE_KEYS)[number]

/** Staff alerts go to the team's notifications, not to the guest's WhatsApp. */
export const STAFF_ALERT_KEYS: readonly MessageKey[] = ['id_alert_staff', 'owner_alert']
export const isStaffAlert = (key: MessageKey): boolean => STAFF_ALERT_KEYS.includes(key)

/**
 * Messages that are not held back by the 09:00 to 20:00 window: staff alerts
 * (internal) and the first form link, which goes out as soon as a registration
 * with a mobile number is saved (owner decision, 18 Oct 2026). The WhatsApp
 * number's daily limit still applies to the form link.
 */
// Owner decision, 18 Oct 2026: no message waits for the window any more, at any hour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const isWindowExempt = (_key: MessageKey): boolean => true

export interface ScheduleInput {
  checkin_at: string | Date
  checkout_at: string | Date
  /** When the stay record was created: the form link is due at once. */
  created_at: string | Date
}

export interface ScheduledMessage {
  key: MessageKey
  dueAt: Date
}

const HOUR_MS = 60 * 60 * 1000

/** When each message is due, before the send window is applied. */
export function computeSchedule(stay: ScheduleInput): ScheduledMessage[] {
  const checkin = new Date(stay.checkin_at)
  const checkout = new Date(stay.checkout_at)
  const created = new Date(stay.created_at)
  return [
    { key: 'form_link', dueAt: created },
    { key: 'form_reminder_3d', dueAt: istDayAt(checkin, -3, 10) },
    { key: 'form_reminder_2d', dueAt: istDayAt(checkin, -2, 10) },
    { key: 'form_reminder_1d', dueAt: istDayAt(checkin, -1, 10) },
    { key: 'id_alert_staff', dueAt: istDayAt(checkin, -1, 17) },
    { key: 'arrival_info', dueAt: istDayAt(checkin, -1, 10) },
    { key: 'access_details', dueAt: istDayAt(checkin, 0, 9) },
    { key: 'owner_alert', dueAt: istDayAt(checkin, 0, 12) },
    { key: 'arrival_check', dueAt: new Date(checkin.getTime() + 2 * HOUR_MS) },
    { key: 'checkout_reminder', dueAt: istDayAt(checkout, -1, 18) },
    { key: 'review_request', dueAt: istDayAt(checkout, 0, 14) },
  ]
}

/** True when `now` is inside the guest-messaging window (09:00 to 20:00 IST). */
export function inSendWindow(now: Date): boolean {
  const h = istHour(now)
  return h >= SEND_WINDOW_START_HOUR && h < SEND_WINDOW_END_HOUR
}

/** The earliest instant at or after `at` that is inside the send window. */
export function shiftIntoWindow(at: Date): Date {
  if (inSendWindow(at)) return at
  const h = istHour(at)
  if (h < SEND_WINDOW_START_HOUR) return istDayAt(at, 0, SEND_WINDOW_START_HOUR)
  return istDayAt(at, 1, SEND_WINDOW_START_HOUR)
}

/** The instant a row may actually be sent: due time moved into the window. */
export function effectiveDueAt(key: MessageKey, dueAt: Date): Date {
  return isWindowExempt(key) ? dueAt : shiftIntoWindow(dueAt)
}
