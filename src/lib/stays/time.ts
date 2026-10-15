// Stay times. Phase 1 runs on Asia/Kolkata (UTC+05:30, no daylight saving),
// so a fixed offset is exact and avoids Intl differences between runtimes.

export const STAY_TIME_ZONE = 'Asia/Kolkata'
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Start (inclusive) and end (exclusive) of the IST calendar day holding `now`. */
export function istDayBounds(now: Date): { start: Date; end: Date } {
  const shifted = now.getTime() + IST_OFFSET_MS
  const startShifted = Math.floor(shifted / DAY_MS) * DAY_MS
  const start = new Date(startShifted - IST_OFFSET_MS)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

/** Calendar year in IST, used for the MS-YYYY-NNN reference. */
export function istYear(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear()
}

/**
 * Parse a date-time from the dashboard or an API client.
 *
 * Strings with an explicit zone ("...Z" or "...+05:30") are honoured. A bare
 * "2026-11-01T14:00" (what <input type="datetime-local"> produces) is read as
 * IST, because staff type the villa's local time.
 */
export function parseStayDateTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const iso = hasZone ? text : `${text}${text.length === 16 ? ':00' : ''}+05:30`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Format an instant as the value an IST <input type="datetime-local"> expects. */
export function toIstInputValue(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16)
}

/** "01 Nov, 2:00 pm" in IST, for lists and the drawer. */
export function formatIst(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: STAY_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}
