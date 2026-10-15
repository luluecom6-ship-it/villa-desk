import { describe, expect, it } from 'vitest'
import { normalizeStayPhone, maskPhone, isValidStayPhone } from './phone'
import { istDayBounds, istYear, parseStayDateTime, toIstInputValue } from './time'
import { automationState, findAutomationStay, isAutomationAllowed } from './automation'
import { parseCreateStay, parsePatchStay } from './validate'
import { filterStays, idStatus, matchesFilter } from './filters'
import type { StayWithGuests } from './types'

describe('normalizeStayPhone', () => {
  it.each([
    ['+91 98765-43210', '919876543210'],
    ['98765 43210', '919876543210'],
    ['098765 43210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+971 50 123 4567', '971501234567'],
    ['00971501234567', '971501234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeStayPhone(input)).toEqual({ phone: expected })
  })

  it('treats empty input as "no number" (a draft), not an error', () => {
    expect(normalizeStayPhone('')).toEqual({ phone: null })
    expect(normalizeStayPhone('   ')).toEqual({ phone: null })
    expect(normalizeStayPhone(null)).toEqual({ phone: null })
  })

  it('rejects numbers that cannot be valid', () => {
    expect(normalizeStayPhone('12345').error).toBe('invalid_phone')
    expect(normalizeStayPhone('abc').error).toBe('invalid_phone')
    expect(normalizeStayPhone('+0123456789012').error).toBe('invalid_phone')
  })

  it('uses a different default country when asked', () => {
    expect(normalizeStayPhone('5012345678', '971')).toEqual({ phone: '9715012345678' })
  })

  it('matches the database CHECK', () => {
    expect(isValidStayPhone('919876543210')).toBe(true)
    expect(isValidStayPhone('0919876543210')).toBe(false)
    expect(isValidStayPhone('1234567')).toBe(false)
    expect(isValidStayPhone('1'.repeat(16))).toBe(false)
  })

  it('masks numbers for logs', () => {
    expect(maskPhone('919876543210')).toBe('91XXXXXX3210')
    expect(maskPhone('919876543210')).not.toContain('98765')
    expect(maskPhone(null)).toBe('')
  })
})

describe('IST time helpers', () => {
  it('finds the IST day for an instant that is still "yesterday" in UTC', () => {
    // 2026-11-01 02:00 IST = 2026-10-31 20:30 UTC
    const { start, end } = istDayBounds(new Date('2026-10-31T20:30:00Z'))
    expect(start.toISOString()).toBe('2026-10-31T18:30:00.000Z') // 00:00 IST on 1 Nov
    expect(end.toISOString()).toBe('2026-11-01T18:30:00.000Z')
  })

  it('uses the IST year for the reference year', () => {
    expect(istYear(new Date('2026-12-31T19:00:00Z'))).toBe(2027) // 00:30 IST on 1 Jan
    expect(istYear(new Date('2026-12-31T18:00:00Z'))).toBe(2026)
  })

  it('reads a bare datetime-local value as IST', () => {
    expect(parseStayDateTime('2026-11-01T14:00')?.toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  it('honours an explicit zone', () => {
    expect(parseStayDateTime('2026-11-01T14:00:00Z')?.toISOString()).toBe('2026-11-01T14:00:00.000Z')
    expect(parseStayDateTime('2026-11-01T14:00:00+05:30')?.toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  it('rejects junk', () => {
    expect(parseStayDateTime('tomorrow')).toBeNull()
    expect(parseStayDateTime('')).toBeNull()
    expect(parseStayDateTime(42)).toBeNull()
  })

  it('round-trips to the input format', () => {
    expect(toIstInputValue('2026-11-01T08:30:00.000Z')).toBe('2026-11-01T14:00')
  })
})

const base = {
  status: 'registered' as const,
  guest_phone: '919876543210',
  automation_paused: false,
  checkout_at: '2026-11-03T05:30:00Z',
  stay_ref: 'MS-2026-001',
}

describe('automationState', () => {
  const now = new Date('2026-11-01T10:00:00Z')

  it('is on for a registered stay with a mobile', () => {
    expect(automationState(base, now)).toEqual({ on: true, reason: null })
  })
  it('explains each way it can be off, in priority order', () => {
    expect(automationState({ ...base, status: 'cancelled' }, now).reason).toBe('cancelled')
    expect(automationState({ ...base, status: 'sample' }, now).reason).toBe('sample')
    expect(automationState({ ...base, guest_phone: null, status: 'draft' }, now).reason).toBe('no_mobile')
    expect(automationState({ ...base, status: 'draft' }, now).reason).toBe('no_mobile')
    expect(automationState({ ...base, automation_paused: true }, now).reason).toBe('paused')
  })
  it('closes 7 days after checkout', () => {
    const justInside = new Date('2026-11-10T05:00:00Z')
    const justOutside = new Date('2026-11-10T05:31:00Z')
    expect(automationState(base, justInside).on).toBe(true)
    expect(automationState(base, justOutside)).toEqual({ on: false, reason: 'closed' })
  })
})

// A tiny stand-in for the supabase query builder: records filters, returns rows.
function fakeClient(rows: Array<Record<string, unknown>>, error: unknown = null) {
  const calls: Array<[string, string, unknown]> = []
  const builder: Record<string, unknown> = {}
  const chain = (op: string) => (col: string, val: unknown) => {
    calls.push([op, col, val])
    return builder
  }
  builder.select = () => builder
  builder.eq = chain('eq')
  builder.gte = chain('gte')
  builder.order = () => builder
  builder.limit = () =>
    Promise.resolve({
      data: error ? null : rows.filter((r) => calls.filter((c) => c[0] === 'eq').every(([, col, val]) => r[col] === val)),
      error,
    })
  return { client: { from: () => builder } as never, calls }
}

describe('isAutomationAllowed (the PDR gate)', () => {
  const now = new Date('2026-11-01T10:00:00Z')
  const row = { id: 's1', stay_ref: 'MS-2026-001', account_id: 'a1', guest_phone: '919876543210', automation_ready: true }

  it('allows a number on a ready stay', async () => {
    const { client } = fakeClient([row])
    expect(await isAutomationAllowed(client, 'a1', '919876543210', now)).toBe(true)
    expect(await findAutomationStay(client, 'a1', '+91 98765 43210', now)).toEqual(
      expect.objectContaining({ id: 's1' }),
    )
  })
  it('blocks a number that is not on any stay', async () => {
    const { client } = fakeClient([row])
    expect(await isAutomationAllowed(client, 'a1', '919000000000', now)).toBe(false)
  })
  it('blocks another account', async () => {
    const { client } = fakeClient([row])
    expect(await isAutomationAllowed(client, 'a2', '919876543210', now)).toBe(false)
  })
  it('blocks a stay that is not automation_ready', async () => {
    const { client } = fakeClient([{ ...row, automation_ready: false }])
    expect(await isAutomationAllowed(client, 'a1', '919876543210', now)).toBe(false)
  })
  it('does not fuzzy-match on the last 8 digits', async () => {
    const { client } = fakeClient([row])
    expect(await isAutomationAllowed(client, 'a1', '449876543210', now)).toBe(false)
  })
  it('never queries for invalid numbers', async () => {
    const { client, calls } = fakeClient([row])
    expect(await isAutomationAllowed(client, 'a1', '123', now)).toBe(false)
    expect(await isAutomationAllowed(client, 'a1', '', now)).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('fails closed when the lookup errors', async () => {
    const { client } = fakeClient([row], { message: 'db down' })
    expect(await isAutomationAllowed(client, 'a1', '919876543210', now)).toBe(false)
  })
  it('limits the lookup to stays that closed within 7 days', async () => {
    const { client, calls } = fakeClient([row])
    await isAutomationAllowed(client, 'a1', '919876543210', now)
    const gte = calls.find((c) => c[0] === 'gte')
    expect(gte?.[1]).toBe('checkout_at')
    expect(gte?.[2]).toBe('2026-10-25T10:00:00.000Z')
  })
})

describe('parseCreateStay', () => {
  const ok = {
    guest_name: ' Asha Rao ',
    guest_phone: '98765 43210',
    checkin_at: '2026-11-01T14:00',
    checkout_at: '2026-11-03T11:00',
    guests_count: 4,
    source: 'airbnb',
    external_booking_ref: ' HMABCD1234 ',
  }

  it('normalises a valid registration', () => {
    const r = parseCreateStay(ok)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.guest_name).toBe('Asha Rao')
      expect(r.value.guest_phone).toBe('919876543210')
      expect(r.value.external_booking_ref).toBe('HMABCD1234')
      expect(r.value.checkin_at).toBe('2026-11-01T08:30:00.000Z')
    }
  })
  it('allows no mobile number (saved as a draft)', () => {
    const r = parseCreateStay({ ...ok, guest_phone: '' })
    expect(r.ok && r.value.guest_phone).toBe(null)
  })
  it('defaults source and guest count', () => {
    const r = parseCreateStay({ guest_name: 'X', checkin_at: ok.checkin_at, checkout_at: ok.checkout_at })
    expect(r.ok && r.value.source).toBe('direct')
    expect(r.ok && r.value.guests_count).toBe(1)
  })
  it('reports field errors', () => {
    const r = parseCreateStay({ guest_name: '', guest_phone: '123', checkin_at: 'x', checkout_at: '', guests_count: 0, source: 'tripadvisor' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toMatchObject({
        guest_name: 'nameRequired',
        guest_phone: 'invalidPhone',
        checkin_at: 'checkinInvalid',
        checkout_at: 'checkoutInvalid',
        guests_count: 'guestsInvalid',
        source: 'sourceInvalid',
      })
    }
  })
  it('rejects checkout before check-in and over-long refs', () => {
    const r = parseCreateStay({ ...ok, checkout_at: '2026-10-30T11:00', external_booking_ref: 'x'.repeat(101) })
    expect(!r.ok && r.errors.checkout_at).toBe('checkoutBeforeCheckin')
    expect(!r.ok && r.errors.external_booking_ref).toBe('refTooLong')
  })
  it('never trusts status, token or reference from the client', () => {
    const r = parseCreateStay({ ...ok, status: 'checked_in', stay_ref: 'MS-1999-001', form_token: 'abc' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value)).not.toEqual(expect.arrayContaining(['status', 'stay_ref', 'form_token']))
  })
})

describe('parsePatchStay', () => {
  it('requires at least one field', () => {
    const r = parsePatchStay({})
    expect(!r.ok && r.errors._form).toBe('nothingToUpdate')
  })
  it('lets staff add, correct or remove the mobile', () => {
    expect(parsePatchStay({ guest_phone: '+91 98765 43210' })).toEqual({ ok: true, value: { guest_phone: '919876543210' } })
    expect(parsePatchStay({ guest_phone: '' })).toEqual({ ok: true, value: { guest_phone: null } })
    const bad = parsePatchStay({ guest_phone: '12' })
    expect(!bad.ok && bad.errors.guest_phone).toBe('invalidPhone')
  })
  it('supports pause and cancel only', () => {
    expect(parsePatchStay({ automation_paused: true })).toEqual({ ok: true, value: { automation_paused: true } })
    expect(parsePatchStay({ status: 'cancelled' })).toEqual({ ok: true, value: { status: 'cancelled' } })
    // any other status (including un-cancelling) is ignored, leaving nothing to update
    expect(parsePatchStay({ status: 'registered' }).ok).toBe(false)
  })
  it('ignores protected columns', () => {
    const r = parsePatchStay({ stay_ref: 'MS-2026-999', form_token: 'x', account_id: 'other', guest_name: 'New' })
    expect(r).toEqual({ ok: true, value: { guest_name: 'New' } })
  })
})

const NOW = new Date('2026-11-01T10:00:00Z') // 15:30 IST on 1 Nov
function stay(over: Partial<StayWithGuests>): StayWithGuests {
  return {
    id: 'x', account_id: 'a', property_id: 'p', contact_id: null, stay_ref: 'MS-2026-001', form_token: 't',
    guest_name: 'Guest', guest_phone: '919876543210', guest_email: null, source: 'direct', external_booking_ref: null,
    status: 'registered', form_status: 'pending', form_submitted_at: null,
    checkin_at: '2026-11-01T08:30:00Z', checkout_at: '2026-11-03T05:30:00Z', guests_count: 2, notes: null,
    automation_paused: false, automation_ready: true, guest_arrived_at: null, closed_at: null,
    created_at: '', updated_at: '', stay_guests: [], ...over,
  }
}
const adult = (over = {}) => ({ id: 'g', role: 'lead' as const, full_name: 'A', is_adult: true, id_type: 'aadhaar', id_last4: '1234', id_verified_at: null, id_rejected_at: null, is_foreign: false, form_c_required: false, ...over })

describe('filters', () => {
  it('arrivals and departures use the IST day', () => {
    expect(matchesFilter(stay({}), 'arrivals_today', NOW)).toBe(true)
    expect(matchesFilter(stay({ checkin_at: '2026-11-02T08:30:00Z' }), 'arrivals_today', NOW)).toBe(false)
    expect(matchesFilter(stay({ checkout_at: '2026-11-01T05:30:00Z' }), 'departures_today', NOW)).toBe(true)
    expect(matchesFilter(stay({ checkin_at: '2026-10-31T18:00:00Z' }), 'arrivals_today', NOW)).toBe(false)
  })
  it('in house, upcoming', () => {
    expect(matchesFilter(stay({}), 'in_house', NOW)).toBe(true)
    expect(matchesFilter(stay({ checkin_at: '2026-11-05T08:30:00Z', checkout_at: '2026-11-07T05:30:00Z' }), 'upcoming', NOW)).toBe(true)
    expect(matchesFilter(stay({}), 'upcoming', NOW)).toBe(false)
  })
  it('form pending and ID not verified', () => {
    expect(matchesFilter(stay({}), 'form_pending', NOW)).toBe(true)
    expect(matchesFilter(stay({ form_status: 'submitted' }), 'form_pending', NOW)).toBe(false)
    expect(matchesFilter(stay({ stay_guests: [adult()] }), 'id_pending', NOW)).toBe(true)
    expect(matchesFilter(stay({ stay_guests: [adult({ id_verified_at: 'x' })] }), 'id_pending', NOW)).toBe(false)
    expect(matchesFilter(stay({ stay_guests: [adult({ id_rejected_at: 'x' })] }), 'id_pending', NOW)).toBe(true)
  })
  it('idStatus', () => {
    expect(idStatus(stay({}))).toBe('none')
    expect(idStatus(stay({ stay_guests: [adult()] }))).toBe('pending')
    expect(idStatus(stay({ stay_guests: [adult({ id_verified_at: 'x' })] }))).toBe('verified')
    expect(idStatus(stay({ stay_guests: [adult({ id_verified_at: 'x' }), adult({ id: 'h', role: 'occupant' })] }))).toBe('pending')
  })
  it('hides cancelled and closed stays by default, shows cancelled on request', () => {
    const list = [stay({ id: '1' }), stay({ id: '2', status: 'cancelled' }), stay({ id: '3', closed_at: 'x' })]
    expect(filterStays(list, 'all', '', NOW).map((s) => s.id)).toEqual(['1'])
    expect(filterStays(list, 'cancelled', '', NOW).map((s) => s.id)).toEqual(['2'])
  })
  it('search covers name, reference, booking ref and mobile, across hidden stays', () => {
    const list = [
      stay({ id: '1', guest_name: 'Asha Rao' }),
      stay({ id: '2', stay_ref: 'MS-2026-002', status: 'cancelled', guest_phone: '919000011111' }),
      stay({ id: '3', external_booking_ref: 'HMABCD1234', guest_phone: null }),
    ]
    expect(filterStays(list, 'all', 'asha', NOW).map((s) => s.id)).toEqual(['1'])
    expect(filterStays(list, 'all', 'ms-2026-002', NOW).map((s) => s.id)).toEqual(['2'])
    expect(filterStays(list, 'all', 'hmabcd', NOW).map((s) => s.id)).toEqual(['3'])
    expect(filterStays(list, 'all', '90000', NOW).map((s) => s.id)).toEqual(['2'])
  })
})
