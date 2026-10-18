// Safety rules for the WhatsApp app number (PDR 8.5). Pure functions, no I/O.
// An app number linked through Evolution is unofficial WhatsApp: the way to
// keep it from being banned is to start slowly, stay inside daytime hours and
// stop at the first sign of trouble.

export type GateCode = 'paused' | 'outside_hours' | 'daily_limit' | 'disconnected' | 'not_configured'

/** Warm-up ramp: messages per day by days since the number was first used. */
export function dailyLimit(warmupStartedAt: Date | null, now: Date, maxDaily: number): number {
  if (!warmupStartedAt) return Math.min(20, maxDaily)
  const day = Math.floor((now.getTime() - warmupStartedAt.getTime()) / 86_400_000) + 1 // day 1 = first day
  const ramp = day <= 3 ? 20 : day <= 7 ? 40 : day <= 14 ? 70 : day <= 21 ? 100 : maxDaily
  return Math.min(ramp, maxDaily)
}

/** Hour of day (0-23) in an IANA time zone. */
export function hourIn(timeZone: string, at: Date): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at)
    return parseInt(h, 10) % 24
  } catch {
    return hourIn('Asia/Kolkata', at)
  }
}

/** Calendar day key (YYYY-MM-DD) in a time zone, for "sent today" counts. */
export function dayKeyIn(timeZone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return dayKeyIn('Asia/Kolkata', at)
  }
}

export function inWindow(timeZone: string, at: Date, startHour: number, endHour: number): boolean {
  const h = hourIn(timeZone, at)
  return h >= startHour && h < endHour
}

/** Auto-pause: 4 or more failures among the last 5 sends. */
export function shouldAutoPause(lastFive: { ok: boolean }[]): boolean {
  const recent = lastFive.slice(0, 5)
  return recent.length >= 4 && recent.filter((r) => !r.ok).length >= 4
}

/**
 * A "close" connection event that means the number must stop sending now:
 * 401 = logged out from the phone, 403 = refused by WhatsApp (possible ban).
 * Other closes are usually temporary; Baileys reconnects by itself.
 */
export function connectionTroubleReason(statusReason: unknown): string | null {
  const code = typeof statusReason === 'number' ? statusReason : Number(statusReason)
  if (code === 401) return 'logged_out'
  if (code === 403) return 'refused_by_whatsapp'
  return null
}

export const GATE_MESSAGES: Record<GateCode, string> = {
  paused: 'Sending through the WhatsApp number is paused.',
  outside_hours: 'Outside the sending hours for the WhatsApp number.',
  daily_limit: "Today's limit for the WhatsApp number is reached.",
  disconnected: 'The WhatsApp number is not connected.',
  not_configured: 'The WhatsApp number has not been linked yet.',
}
