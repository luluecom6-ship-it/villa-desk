import { describe, expect, it } from 'vitest'
import { computeSchedule, effectiveDueAt, inSendWindow, shiftIntoWindow, MESSAGE_KEYS, isStaffAlert } from './schedule'
import { judge, allAdultIdsVerified, isInHouse } from './conditions'
import { DEFAULT_TEMPLATES, META_TEMPLATE_PARAMS, renderTemplate, unknownVariables, firstName, TEMPLATE_VARIABLES } from './templates'

// IST helper: "2026-11-01 14:00" IST
const ist = (s: string) => new Date(s.replace(' ', 'T') + ':00+05:30')
const iso = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')

const stay = {
  checkin_at: ist('2026-11-10 14:00'),
  checkout_at: ist('2026-11-12 11:00'),
  created_at: ist('2026-11-01 08:00'),
}

describe('schedule', () => {
  const s = Object.fromEntries(computeSchedule(stay).map((m) => [m.key, iso(m.dueAt)]))
  it('covers every message key once', () => {
    expect(Object.keys(s).sort()).toEqual([...MESSAGE_KEYS].sort())
  })
  it('form link is due at registration, reminders at 10:00 on days 3, 2, 1 before', () => {
    expect(s.form_link).toBe('2026-11-01 08:00')
    expect(s.form_reminder_3d).toBe('2026-11-07 10:00')
    expect(s.form_reminder_2d).toBe('2026-11-08 10:00')
    expect(s.form_reminder_1d).toBe('2026-11-09 10:00')
  })
  it('follows PDR 7.1 for the arrival and checkout messages', () => {
    expect(s.arrival_info).toBe('2026-11-09 10:00')
    expect(s.access_details).toBe('2026-11-10 09:00')
    expect(s.owner_alert).toBe('2026-11-10 12:00')
    expect(s.arrival_check).toBe('2026-11-10 16:00')
    expect(s.checkout_reminder).toBe('2026-11-11 18:00')
    expect(s.review_request).toBe('2026-11-12 14:00')
  })
})

describe('send window (09:00 to 20:00 IST)', () => {
  it('knows the window edges', () => {
    expect(inSendWindow(ist('2026-11-10 08:59'))).toBe(false)
    expect(inSendWindow(ist('2026-11-10 09:00'))).toBe(true)
    expect(inSendWindow(ist('2026-11-10 19:59'))).toBe(true)
    expect(inSendWindow(ist('2026-11-10 20:00'))).toBe(false)
  })
  it('moves early messages to 09:00 the same day and late ones to 09:00 next day', () => {
    expect(iso(shiftIntoWindow(ist('2026-11-10 06:30')))).toBe('2026-11-10 09:00')
    expect(iso(shiftIntoWindow(ist('2026-11-10 21:15')))).toBe('2026-11-11 09:00')
    expect(iso(shiftIntoWindow(ist('2026-11-10 23:59')))).toBe('2026-11-11 09:00')
    expect(iso(shiftIntoWindow(ist('2026-11-10 12:00')))).toBe('2026-11-10 12:00')
  })
  it('does not hold back staff alerts', () => {
    expect(iso(effectiveDueAt('owner_alert', ist('2026-11-10 22:00')))).toBe('2026-11-10 22:00')
    expect(iso(effectiveDueAt('arrival_check', ist('2026-11-10 22:00')))).toBe('2026-11-11 09:00')
    expect(isStaffAlert('id_alert_staff')).toBe(true)
    expect(isStaffAlert('form_link')).toBe(false)
  })
})

const base = { status: 'registered', form_status: 'pending', ...stay }
const verified = [{ is_adult: true, id_verified_at: '2026-11-09T00:00:00Z' }]
const unverified = [{ is_adult: true, id_verified_at: null }]

describe('conditions', () => {
  const before = ist('2026-11-05 11:00')
  it('form reminders need a pending form', () => {
    expect(judge('form_reminder_2d', base, [], before).verdict).toBe('send')
    expect(judge('form_reminder_2d', { ...base, form_status: 'submitted' }, [], before).verdict).toBe('skip')
    expect(judge('form_link', base, [], ist('2026-11-10 15:00')).verdict).toBe('skip')
  })
  it('arrival info waits for the form, never sends after arrival', () => {
    const day = ist('2026-11-09 10:00')
    expect(judge('arrival_info', base, [], day).verdict).toBe('wait')
    expect(judge('arrival_info', { ...base, form_status: 'submitted' }, [], day).verdict).toBe('send')
    expect(judge('arrival_info', base, [], ist('2026-11-10 15:00')).verdict).toBe('skip')
  })
  it('access details wait for verified IDs', () => {
    const day = ist('2026-11-10 09:00')
    expect(judge('access_details', base, unverified, day).verdict).toBe('wait')
    expect(judge('access_details', base, [], day).verdict).toBe('wait')
    expect(judge('access_details', base, verified, day).verdict).toBe('send')
    expect(judge('access_details', base, verified, ist('2026-11-12 12:00')).verdict).toBe('skip')
  })
  it('staff alerts: unverified IDs / incomplete form only', () => {
    const day = ist('2026-11-09 17:00')
    expect(judge('id_alert_staff', base, unverified, day).verdict).toBe('send')
    expect(judge('id_alert_staff', base, verified, day).verdict).toBe('skip')
    expect(judge('owner_alert', base, [], ist('2026-11-10 12:00')).verdict).toBe('send')
    expect(judge('owner_alert', { ...base, form_status: 'submitted' }, [], ist('2026-11-10 12:00')).verdict).toBe('skip')
  })
  it('arrival check needs the guest in the house', () => {
    expect(judge('arrival_check', base, [], ist('2026-11-10 16:00')).verdict).toBe('send')
    expect(judge('arrival_check', { ...base, status: 'cancelled' }, [], ist('2026-11-10 16:00')).verdict).toBe('wait')
    expect(judge('arrival_check', { ...base, status: 'cancelled' }, [], ist('2026-11-11 00:30')).verdict).toBe('skip')
  })
  it('checkout reminder and review follow the stay', () => {
    expect(judge('checkout_reminder', { ...base, status: 'checked_in' }, [], ist('2026-11-11 18:00')).verdict).toBe('send')
    expect(judge('checkout_reminder', { ...base, status: 'checked_in' }, [], ist('2026-11-12 12:00')).verdict).toBe('skip')
    expect(judge('review_request', base, [], ist('2026-11-12 14:00')).verdict).toBe('send')
    expect(judge('review_request', { ...base, status: 'checked_out' }, [], ist('2026-11-12 09:00')).verdict).toBe('send')
    expect(judge('review_request', base, [], ist('2026-11-11 14:00')).verdict).toBe('wait')
  })
  it('helpers', () => {
    expect(allAdultIdsVerified([])).toBe(false)
    expect(allAdultIdsVerified([...verified, { is_adult: false, id_verified_at: null }])).toBe(true)
    expect(isInHouse({ ...base, status: 'draft' }, ist('2026-11-11 10:00'))).toBe(false)
  })
})

describe('templates', () => {
  it('every default uses only known variables, and every key has wording', () => {
    for (const key of MESSAGE_KEYS) {
      expect(DEFAULT_TEMPLATES[key]).toBeTruthy()
      expect(unknownVariables(DEFAULT_TEMPLATES[key])).toEqual([])
      for (const v of META_TEMPLATE_PARAMS[key]) expect(TEMPLATE_VARIABLES).toContain(v)
    }
  })
  it('renders variables, keeps unknown ones visible, tidies blank lines', () => {
    expect(renderTemplate('Hi {guest_first_name} {oops}', { guest_first_name: 'Asha' })).toBe('Hi Asha {oops}')
    expect(renderTemplate('A\n{directions}\nB', { directions: '' })).toBe('A\n\nB')
    expect(unknownVariables('x {a} {guest_first_name} {b}')).toEqual(['a', 'b'])
  })
  it('first name', () => {
    expect(firstName('  Asha  Rao ')).toBe('Asha')
    expect(firstName('')).toBe('')
  })
})
