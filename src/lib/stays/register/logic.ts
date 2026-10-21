// "Register New" over WhatsApp (caretaker / admin / owner). Pure parsing, tested.
//
//   1. They write "Register New" to the villa number.
//   2. The bot sends REGISTER_TEMPLATE: copy it, fill it in, send it back.
//   3. parseRegisterMessage() reads the labelled lines; the stay is created with the same rules as the app.

import { STAY_SOURCES, type StaySource } from '../types'

/** "Register New", "register", "new registration", "/new" (nothing else on the line). */
export function isRegisterRequest(text: string | null | undefined): boolean {
  const t = (text ?? '').trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ')
  return ['register new', 'new register', 'register', 'new registration', 'new booking'].includes(t)
}

export const REGISTER_TEMPLATE = [
  '*New registration.* Copy the message below, fill it in and send it back:',
  '',
  'Register',
  'Name: ',
  'Mobile: ',
  'Check-in: 25 Oct 2026 2:00 PM',
  'Check-out: 27 Oct 2026 11:00 AM',
  'Guests: 2',
  'Source: direct',
  'Booking ref: ',
  'Notes: ',
  '',
  'Source can be: airbnb, booking, makemytrip, goibibo, direct or other.',
  'Booking ref and Notes are optional. A 10-digit mobile is taken as an Indian (+91) number; for any other country write the full number with the country code, e.g. 966572657189.',
].join('\n')

const LABELS: Array<[string, RegExp]> = [
  ['name', /^(guest\s*name|name)$/i],
  ['mobile', /^(mobile|mobile\s*no\.?|phone|whatsapp|contact|number)$/i],
  ['checkin', /^(check[\s-]*in|checkin|arrival|from)$/i],
  ['checkout', /^(check[\s-]*out|checkout|departure|to)$/i],
  ['guests', /^(guests?|pax|persons?|people|no\.?\s*of\s*guests)$/i],
  ['source', /^(source|platform|booked\s*(on|via|from))$/i],
  ['ref', /^(booking\s*ref(erence)?|ref(erence)?|booking\s*id|ref\s*no\.?)$/i],
  ['notes', /^(notes?|remarks?)$/i],
  ['email', /^(email|e-mail)$/i],
]

/** True when the text looks like a filled-in form (has at least a Name and a Mobile line). */
export function looksLikeRegisterForm(text: string | null | undefined): boolean {
  const f = readFields(text ?? '')
  return 'name' in f && 'mobile' in f
}

function readFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    // "Label: value" (or "=" ); a spaced dash ("Guest name - Ravi") is accepted too, but a dash inside a label ("Check-in") is not a separator.
    const m = /^\s*([A-Za-z][A-Za-z .\-/]{0,30}?)\s*[:=]\s*(.*)$/.exec(raw) ?? /^\s*([A-Za-z][A-Za-z .]{0,30}?)\s+-\s+(.*)$/.exec(raw)
    if (!m) continue
    const hit = LABELS.find(([, re]) => re.test(m[1].trim()))
    if (hit && !(hit[0] in out)) out[hit[0]] = m[2].trim()
  }
  return out
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const pad = (n: number) => String(n).padStart(2, '0')

/** IST calendar parts of an instant. */
function istParts(now: Date): { y: number; m: number; d: number } {
  const s = new Date(now.getTime() + 330 * 60_000)
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() }
}

/**
 * "25 Oct 2026 2:00 PM", "25-10-2026 14:00", "25/10/26 2pm", "25 Oct 2pm" (no year), "25 Oct" (default time).
 * Returns "YYYY-MM-DDTHH:mm" (read as IST by the app) or null.
 */
export function parseLooseDateTime(raw: string, now: Date, defaultTime: { h: number; m: number }): string | null {
  let s = raw.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  if (!s) return null

  // time: 2:00 pm | 2pm | 14:00
  let h = defaultTime.h
  let min = defaultTime.m
  const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(\d{1,2}):(\d{2})\b(?!\s*[-/])/.exec(s.replace(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/, ' '))
  let timeText = ''
  if (tm) {
    timeText = tm[0]
    if (tm[3]) {
      h = Number(tm[1]) % 12 + (tm[3] === 'pm' ? 12 : 0)
      min = Number(tm[2] ?? 0)
    } else {
      h = Number(tm[4])
      min = Number(tm[5])
    }
    if (h > 23 || min > 59) return null
    s = s.replace(timeText, ' ').replace(/\s+/g, ' ').trim()
  }

  let y: number | null = null
  let mo = 0
  let d = 0
  const m1 = /(\d{1,2})\s*(?:st|nd|rd|th)?[\s-/]+([a-z]{3,9})\.?(?:[\s-/]+(\d{2,4}))?/.exec(s)
  if (m1 && MONTHS[m1[2].slice(0, 4) === 'sept' ? 'sept' : m1[2].slice(0, 3)]) {
    d = Number(m1[1]); mo = MONTHS[m1[2].slice(0, 4) === 'sept' ? 'sept' : m1[2].slice(0, 3)]
    if (m1[3]) y = Number(m1[3])
  } else {
    const m2 = /(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?/.exec(s)
    if (!m2) return null
    d = Number(m2[1]); mo = Number(m2[2])
    if (m2[3]) y = Number(m2[3])
  }
  if (y !== null && y < 100) y += 2000
  const today = istParts(now)
  if (y === null) {
    y = today.y
    // No year: pick this year, or next year when that date is long past (typing "5 Jan" in December).
    const cand = Date.UTC(y, mo - 1, d)
    if (cand < Date.UTC(today.y, today.m - 1, today.d) - 60 * 86_400_000) y += 1
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(min)}`
}

const SOURCE_WORDS: Array<[RegExp, StaySource]> = [
  [/air\s*bnb/, 'airbnb'],
  [/booking/, 'booking_com'],
  [/make\s*my\s*trip|^mmt$/, 'makemytrip'],
  [/goibibo/, 'goibibo'],
  [/direct|walk|own|phone|call|whatsapp/, 'direct'],
  [/other/, 'other'],
]

export function parseSource(raw: string): StaySource | null {
  const t = raw.trim().toLowerCase()
  if (!t) return 'direct'
  if ((STAY_SOURCES as readonly string[]).includes(t)) return t as StaySource
  return SOURCE_WORDS.find(([re]) => re.test(t))?.[1] ?? null
}

export type RegisterParse =
  | { ok: true; body: { guest_name: string; guest_phone: string; checkin_at: string; checkout_at: string; guests_count: number; source: StaySource; external_booking_ref: string; notes: string; guest_email: string } }
  | { ok: false; problems: string[] }

/** Read a filled-in form into the fields POST /api/stays understands. Problems are plain sentences for the caretaker. */
export function parseRegisterMessage(text: string, now: Date = new Date()): RegisterParse {
  const f = readFields(text)
  const problems: string[] = []

  const name = (f.name ?? '').trim()
  if (!name) problems.push('Name is missing.')
  const mobile = (f.mobile ?? '').trim()
  if (!mobile) problems.push('Mobile is missing.')

  const checkin = parseLooseDateTime(f.checkin ?? '', now, { h: 14, m: 0 })
  const checkout = parseLooseDateTime(f.checkout ?? '', now, { h: 11, m: 0 })
  if (!checkin) problems.push('Check-in date is missing or not understood. Write it like: 25 Oct 2026 2:00 PM')
  if (!checkout) problems.push('Check-out date is missing or not understood. Write it like: 27 Oct 2026 11:00 AM')
  if (checkin && checkout && checkout <= checkin) problems.push('Check-out must be after check-in.')

  let guests = 1
  if ((f.guests ?? '').trim()) {
    guests = Number((f.guests ?? '').replace(/\D/g, ''))
    if (!Number.isInteger(guests) || guests < 1 || guests > 30) problems.push('Guests must be a number from 1 to 30.')
  }
  const source = parseSource(f.source ?? '')
  if (!source) problems.push('Source must be one of: airbnb, booking, makemytrip, goibibo, direct, other.')

  if (problems.length > 0 || !source || !checkin || !checkout) return { ok: false, problems }
  return {
    ok: true,
    body: {
      guest_name: name,
      guest_phone: mobile,
      checkin_at: checkin,
      checkout_at: checkout,
      guests_count: guests,
      source,
      external_booking_ref: (f.ref ?? '').trim(),
      notes: (f.notes ?? '').trim(),
      guest_email: (f.email ?? '').trim(),
    },
  }
}
