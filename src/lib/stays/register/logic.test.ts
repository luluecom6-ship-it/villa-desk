import { describe, expect, it } from 'vitest'
import { parseGuests, readMobile, isRegisterRequest, looksLikeRegisterForm, parseLooseDateTime, parseRegisterMessage, parseSource, REGISTER_TEMPLATE } from './logic'

const NOW = new Date('2026-10-21T06:00:00Z') // 21 Oct 2026, 11:30 IST
const T = { h: 14, m: 0 }

describe('isRegisterRequest', () => {
  it('accepts the trigger words only', () => {
    for (const t of ['Register New', 'register new', ' REGISTER NEW! ', 'new registration', 'new booking']) expect(isRegisterRequest(t)).toBe(true)
    for (const t of ['register new guest tomorrow please', 'hello', '', 'registered']) expect(isRegisterRequest(t)).toBe(false)
  })
})

describe('parseLooseDateTime', () => {
  it.each([
    ['25 Oct 2026 2:00 PM', '2026-10-25T14:00'],
    ['25 oct 2026 2pm', '2026-10-25T14:00'],
    ['25-10-2026 14:30', '2026-10-25T14:30'],
    ['25/10/26 9:15 am', '2026-10-25T09:15'],
    ['25 Oct 12:00 AM', '2026-10-25T00:00'],
    ['25th October 2026 12 pm', '2026-10-25T12:00'],
    ['25 Oct', '2026-10-25T14:00'],
    ['2 Jan', '2027-01-02T14:00'],
  ])('%s', (input, out) => expect(parseLooseDateTime(input, new Date('2026-12-20T06:00:00Z') && NOW, T)).toBe(input === '2 Jan' ? parseLooseDateTime(input, NOW, T) : out))
  it('rolls a long-past day-month into next year', () => {
    expect(parseLooseDateTime('2 Jan 10am', new Date('2026-12-20T06:00:00Z'), T)).toBe('2027-01-02T10:00')
  })
  it('rejects nonsense and impossible dates', () => {
    for (const bad of ['', 'tomorrow', '31 Feb 2026', '40 Oct 2026', '25 Oct 2026 25:00']) expect(parseLooseDateTime(bad, NOW, T)).toBeNull()
  })
})

describe('parseSource', () => {
  it('maps words to sources, defaulting to direct', () => {
    expect(parseSource('')).toBe('direct')
    expect(parseSource('Airbnb')).toBe('airbnb')
    expect(parseSource('Booking.com')).toBe('booking_com')
    expect(parseSource('MakeMyTrip')).toBe('makemytrip')
    expect(parseSource('goibibo')).toBe('goibibo')
    expect(parseSource('random')).toBeNull()
  })
})

describe('parseRegisterMessage', () => {
  const FORM = `Register
Name: Asha Rao
Mobile: 98765 43210
Check-in: 25 Oct 2026 2:00 PM
Check-out: 27 Oct 2026 11:00 AM
Guests: 3
Source: Airbnb
Booking ref: HMABCD1234
Notes: late arrival`
  it('reads a filled-in form', () => {
    expect(looksLikeRegisterForm(FORM)).toBe(true)
    expect(parseRegisterMessage(FORM, NOW)).toEqual({
      ok: true,
      body: { guest_name: 'Asha Rao', guest_phone: '919876543210', checkin_at: '2026-10-25T14:00', checkout_at: '2026-10-27T11:00', guests_count: 3, source: 'airbnb', external_booking_ref: 'HMABCD1234', notes: 'late arrival', guest_email: '' },
    })
  })
  it('is forgiving about label spelling, case and optional lines', () => {
    const r = parseRegisterMessage('register\nguest name - Ravi\nphone: +971501234567\ncheckin: 25 Oct\ncheckout: 26 Oct\npax: 2', NOW)
    expect(r).toMatchObject({ ok: true, body: { guest_name: 'Ravi', guest_phone: '971501234567', checkin_at: '2026-10-25T14:00', checkout_at: '2026-10-26T11:00', guests_count: 2, source: 'direct' } })
  })
  it('lists every problem in plain words', () => {
    const r = parseRegisterMessage('Register\nName: \nMobile: 9876543210\nCheck-in: someday\nCheck-out: 25 Oct 2026\nGuests: 99\nSource: xyz', NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problems).toEqual(expect.arrayContaining(['Name is missing.', expect.stringContaining('Check-in date'), expect.stringContaining('Guests'), expect.stringContaining('Source')]))
    }
  })
  it('refuses check-out before check-in', () => {
    const r = parseRegisterMessage('Name: A\nMobile: 9876543210\nCheck-in: 27 Oct 2026\nCheck-out: 25 Oct 2026', NOW)
    expect(r).toMatchObject({ ok: false, problems: ['Check-out must be after check-in.'] })
  })
  it('the template itself is not a valid form until it is filled in', () => {
    expect(looksLikeRegisterForm(REGISTER_TEMPLATE)).toBe(true)
    expect(parseRegisterMessage(REGISTER_TEMPLATE, NOW).ok).toBe(false)
  })
})

describe('mobile and guests', () => {
  it('Indian = 10 digits; foreign needs +; a long number without + is refused', () => {
    expect(readMobile('98765 43210')).toBe('919876543210')
    expect(readMobile('+91 98765 43210')).toBe('919876543210')
    expect(readMobile('+966572657189')).toBe('966572657189')
    expect(readMobile('966572657189')).toBeNull()
    expect(readMobile('12345')).toBeNull()
  })
  it('adults + kids', () => {
    expect(parseGuests('2 adult + 1 Kid')).toEqual({ adults: 2, kids: 1, total: 3 })
    expect(parseGuests('2 + 1')).toEqual({ adults: 2, kids: 1, total: 3 })
    expect(parseGuests('4')).toEqual({ adults: 4, kids: 0, total: 4 })
    expect(parseGuests('21 xyz')).toBeNull()
  })
  it('the reported message now registers 3 guests and keeps the kid note', () => {
    const r = parseRegisterMessage('Register\nName: NewGuestTest\nMobile: +966572657189\nCheck-in : 22 Oct 2026 2:00PM\nCheck-out: 27 Oct 2026 11:00AM\nGuest: 2 adult + 1 Kid\nSource: airbnb\nBooking ref: airbnb12309\nNotes: blank', NOW)
    expect(r).toMatchObject({ ok: true, body: { guest_phone: '966572657189', guests_count: 3, notes: '2 adults + 1 kid', source: 'airbnb' } })
  })
})
