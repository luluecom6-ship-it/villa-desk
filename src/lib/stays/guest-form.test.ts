import { describe, expect, it } from 'vitest'
import {
  checkUpload,
  fitWithin,
  MAX_FILE_BYTES,
  sha256Hex,
  sniffFileType,
} from './files'
import { parseGuestForm, type ParseContext } from './guest-form'

const bytes = (...b: number[]) => new Uint8Array(b)
const pad = (head: number[], total = 64) => {
  const u = new Uint8Array(total)
  u.set(head)
  return u
}

describe('sniffFileType (content, not file name)', () => {
  it('recognises JPEG, PNG, WebP and PDF', () => {
    expect(sniffFileType(pad([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe('image/jpeg')
    expect(sniffFileType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe('png')
    expect(
      sniffFileType(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.contentType,
    ).toBe('image/webp')
    expect(sniffFileType(pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))?.contentType).toBe('application/pdf')
  })
  it('rejects everything else, whatever it is called', () => {
    // A Windows executable ("MZ") renamed to .jpg
    expect(sniffFileType(pad([0x4d, 0x5a, 0x90, 0x00]))).toBeNull()
    // HTML / script content
    expect(sniffFileType(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull()
    // RIFF but not WebP (e.g. WAV)
    expect(sniffFileType(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull()
    expect(sniffFileType(bytes())).toBeNull()
    expect(sniffFileType(bytes(0xff, 0xd8))).toBeNull() // too short to be a JPEG header
  })
})

describe('checkUpload', () => {
  it('accepts a valid file', () => {
    const r = checkUpload(pad([0xff, 0xd8, 0xff]))
    expect(r.ok && r.type.contentType).toBe('image/jpeg')
  })
  it('rejects empty, oversize and unknown files', () => {
    expect(checkUpload(new Uint8Array(0))).toEqual({ ok: false, problem: 'empty' })
    const big = new Uint8Array(MAX_FILE_BYTES + 1)
    big.set([0xff, 0xd8, 0xff])
    expect(checkUpload(big)).toEqual({ ok: false, problem: 'tooLarge' })
    expect(checkUpload(pad([1, 2, 3]))).toEqual({ ok: false, problem: 'unsupportedType' })
  })
  it('accepts exactly 8 MB', () => {
    const edge = new Uint8Array(MAX_FILE_BYTES)
    edge.set([0xff, 0xd8, 0xff])
    expect(checkUpload(edge).ok).toBe(true)
  })
})

describe('fitWithin (client-side shrink to 1600 px)', () => {
  it('scales the long edge to 1600 and keeps the ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 })
  })
  it('never scales up', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 })
  })
  it('stays at least 1 px', () => {
    expect(fitWithin(100000, 1)).toEqual({ width: 1600, height: 1 })
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

const RULES = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({ alreadySigned: false, existingFronts: [], ...over })

function form(over: Record<string, unknown> = {}) {
  return {
    lead: {
      full_name: 'Asha Rao',
      mobile: '',
      email: 'asha@example.com',
      is_foreign: false,
      nationality: '',
      address: '12 MG Road, Bengaluru',
      id_type: 'aadhaar',
      id_last4: '1234',
      visa_type: '',
      visa_expiry: '',
      arrived_in_india_on: '',
    },
    arrival: { expected_arrival_time: '15:30', vehicle_number: 'KA01AB1234', special_request: '', purpose_of_visit: 'leisure' },
    occupants: [],
    documents: [{ guest_key: 'lead', side: 'front' }],
    acceptance: { accepted: true, typed_name: 'Asha Rao', rules_version_id: RULES },
    ...over,
  }
}

describe('parseGuestForm', () => {
  it('accepts a complete form', () => {
    const r = parseGuestForm(form(), ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.lead.nationality).toBe('Indian')
      expect(r.value.acceptance).toEqual({ rules_version_id: RULES, typed_name: 'Asha Rao' })
    }
  })

  it('rejects a full ID number: only the last 4 may be stored', () => {
    const f = form()
    f.lead.id_last4 = '123456789012'
    const r = parseGuestForm(f, ctx())
    expect(!r.ok && r.errors['lead.id_last4']).toBe('invalidLast4')
    f.lead.id_last4 = '12'
    expect(!parseGuestForm(f, ctx()).ok).toBe(true)
  })

  it('requires the basics, but only reports a field once it is wrong', () => {
    const f = form()
    f.lead.full_name = ' '
    f.lead.address = 'x'
    f.lead.id_type = ''
    const r = parseGuestForm(f, ctx())
    expect(!r.ok && r.errors).toMatchObject({
      'lead.full_name': 'required',
      'lead.address': 'required',
      'lead.id_type': 'idTypeRequired',
    })
  })

  it('foreign guests need a nationality and a passport, and set up Form C data', () => {
    const f = form()
    f.lead.is_foreign = true
    let r = parseGuestForm(f, ctx())
    expect(!r.ok && r.errors['lead.nationality']).toBe('required')
    expect(!r.ok && r.errors['lead.id_type']).toBe('passportRequired')
    f.lead.nationality = 'German'
    f.lead.id_type = 'passport'
    f.lead.visa_expiry = '2027-01-15'
    f.lead.arrived_in_india_on = 'yesterday'
    r = parseGuestForm(f, ctx())
    expect(!r.ok && r.errors['lead.arrived_in_india_on']).toBe('invalidDate')
    f.lead.arrived_in_india_on = '2026-10-30'
    r = parseGuestForm(f, ctx())
    expect(r.ok && r.value.lead).toMatchObject({ is_foreign: true, nationality: 'German', visa_expiry: '2027-01-15' })
  })

  it('drops visa fields for Indian guests', () => {
    const f = form()
    f.lead.visa_type = 'Tourist'
    f.lead.visa_expiry = '2027-01-15'
    const r = parseGuestForm(f, ctx())
    expect(r.ok && r.value.lead).toMatchObject({ visa_type: '', visa_expiry: '' })
  })

  it('validates arrival details', () => {
    const f = form({ arrival: { expected_arrival_time: '25:99', vehicle_number: 'x'.repeat(21), special_request: '', purpose_of_visit: 'holiday' } })
    const r = parseGuestForm(f, ctx())
    expect(!r.ok && r.errors).toMatchObject({
      'arrival.expected_arrival_time': 'invalidTime',
      'arrival.vehicle_number': 'tooLong',
      'arrival.purpose_of_visit': 'badRequest',
    })
  })

  describe('occupants', () => {
    const adult = { client_key: 'o1', full_name: 'Ravi', age: '34', id_type: 'passport', id_last4: 'X123' }
    const child = { client_key: 'o2', full_name: 'Mini', age: '7', id_type: '', id_last4: '' }

    it('every guest, children included, needs ID type, last 4 and a front photo (back optional)', () => {
      const withId = { ...child, id_type: 'aadhaar', id_last4: '4321' }
      const r = parseGuestForm(
        form({
          occupants: [adult, withId],
          documents: [
            { guest_key: 'lead', side: 'front' },
            { guest_key: 'o1', side: 'front' },
            { guest_key: 'o2', side: 'front' },
          ],
        }),
        ctx(),
      )
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.value.occupants[0]).toMatchObject({ is_adult: true, age: 34 })
        expect(r.value.occupants[1]).toMatchObject({ age: 7, id_type: 'aadhaar', id_last4: '4321' })
      }
      const noPhoto = parseGuestForm(form({ occupants: [withId], documents: [{ guest_key: 'lead', side: 'front' }] }), ctx())
      expect(!noPhoto.ok && noPhoto.errors['documents.o2']).toBe('idPhotoRequired')
      const noType = parseGuestForm(form({ occupants: [child], documents: [{ guest_key: 'lead', side: 'front' }, { guest_key: 'o2', side: 'front' }] }), ctx())
      expect(!noType.ok && noType.errors['occupants.0.id_type']).toBe('idTypeRequired')
    })
    it('a 17-year-old and an 18-year-old are treated the same: both need an ID', () => {
      for (const age of ['17', '18']) {
        const r = parseGuestForm(form({ occupants: [{ ...adult, age }], documents: [{ guest_key: 'lead', side: 'front' }] }), ctx())
        expect(!r.ok && r.errors['documents.o1']).toBe('idPhotoRequired')
      }
    })
    it('an adult with no photo is rejected unless one is already on file', () => {
      const f = form({ occupants: [adult], documents: [{ guest_key: 'lead', side: 'front' }] })
      expect(!parseGuestForm(f, ctx()).ok).toBe(true)
      expect(parseGuestForm(f, ctx({ existingFronts: ['o1'] })).ok).toBe(true)
    })
    it('the lead also needs a photo or an earlier one on file', () => {
      const f = form({ documents: [] })
      const r = parseGuestForm(f, ctx())
      expect(!r.ok && r.errors['documents.lead']).toBe('idPhotoRequired')
      expect(parseGuestForm(f, ctx({ existingFronts: ['lead'] })).ok).toBe(true)
    })
    it('rejects bad ages, duplicate keys and too many people', () => {
      const r = parseGuestForm(form({ occupants: [{ ...child, age: '' }, { ...child, client_key: 'o2' }] }), ctx())
      expect(!r.ok && r.errors['occupants.0.age']).toBe('invalidAge')
      expect(!r.ok && r.errors['occupants.1.client_key']).toBe('badRequest')
      const many = Array.from({ length: 13 }, (_, i) => ({ ...child, client_key: `k${i}` }))
      expect(!parseGuestForm(form({ occupants: many }), ctx()).ok).toBe(true)
    })
    it('keeps the id of a previously saved person', () => {
      const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
      const kid = { ...child, id_type: 'aadhaar', id_last4: '4321' }
      const docs = [{ guest_key: 'lead', side: 'front' }, { guest_key: 'o2', side: 'front' }]
      const r = parseGuestForm(form({ occupants: [{ ...kid, id }], documents: docs }), ctx())
      expect(r.ok && r.value.occupants[0]).toMatchObject({ id })
      const bad = parseGuestForm(form({ occupants: [{ ...kid, id: 'not-a-uuid' }], documents: docs }), ctx())
      expect(!bad.ok && bad.errors['occupants.0.id']).toBe('badRequest')
    })
  })

  describe('documents', () => {
    it('rejects files for unknown people, duplicates and bad sides', () => {
      const child = { client_key: 'o2', full_name: 'Mini', age: '7', id_type: 'aadhaar', id_last4: '4321' }
      const r = parseGuestForm(
        form({
          occupants: [child],
          documents: [
            { guest_key: 'lead', side: 'front' },
            { guest_key: 'o2', side: 'front' },
            { guest_key: 'ghost', side: 'front' },
            { guest_key: 'lead', side: 'front' },
            { guest_key: 'lead', side: 'side' },
          ],
        }),
        ctx(),
      )
      expect(!r.ok && Object.keys(r.errors).filter((k) => k.startsWith('documents.')).length).toBe(3)
    })
    it('allows a back side', () => {
      const r = parseGuestForm(form({ documents: [{ guest_key: 'lead', side: 'front' }, { guest_key: 'lead', side: 'back' }] }), ctx())
      expect(r.ok && r.value.documents).toHaveLength(2)
    })
  })

  describe('acceptance', () => {
    it('needs the box ticked and a typed name', () => {
      const r = parseGuestForm(form({ acceptance: { accepted: false, typed_name: '', rules_version_id: RULES } }), ctx())
      expect(!r.ok && r.errors).toMatchObject({
        'acceptance.accepted': 'acceptRules',
        'acceptance.typed_name': 'signatureRequired',
      })
    })
    it('is not required again when the stay is already signed', () => {
      const r = parseGuestForm(form({ acceptance: { accepted: false, typed_name: '', rules_version_id: '' } }), ctx({ alreadySigned: true }))
      expect(r.ok).toBe(true)
    })
    it('rejects a malformed rules version id', () => {
      const r = parseGuestForm(form({ acceptance: { accepted: true, typed_name: 'Asha', rules_version_id: 'x' } }), ctx())
      expect(!r.ok && r.errors['acceptance.rules_version_id']).toBe('badRequest')
    })
  })

  it('rejects non-objects', () => {
    expect(parseGuestForm(null, ctx()).ok).toBe(false)
    expect(parseGuestForm('x', ctx()).ok).toBe(false)
  })
})

describe('Form 1 extra fields', () => {
  const ctx: ParseContext = { alreadySigned: true, existingFronts: ['lead'] }
  const base = (lead: Record<string, unknown> = {}, occ: Record<string, unknown>[] = []) => ({
    lead: { full_name: 'Asha Rao', address: 'Bengaluru', id_type: 'aadhaar', id_last4: '1234', ...lead },
    arrival: {},
    occupants: occ,
    documents: [],
    acceptance: {},
  })
  it('cleans phone numbers to digits and keeps the optional fields', () => {
    const r = parseGuestForm(base({ alternate_mobile: '+91 98000-00001', occupation: ' Engineer ', emergency_name: 'Mother', emergency_phone: '(91) 9800000002' }), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.lead).toMatchObject({ alternate_mobile: '919800000001', occupation: 'Engineer', emergency_name: 'Mother', emergency_phone: '919800000002' })
  })
  it('is fine when all of them are left empty', () => {
    expect(parseGuestForm(base(), ctx).ok).toBe(true)
  })
  it('rejects bad phones and an emergency name without a number (or the reverse)', () => {
    const bad = parseGuestForm(base({ alternate_mobile: '12ab' }), ctx)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors['lead.alternate_mobile']).toBe('invalidPhone')
    const half = parseGuestForm(base({ emergency_name: 'Mother' }), ctx)
    expect(half.ok).toBe(false)
    if (!half.ok) expect(half.errors['lead.emergency_phone']).toBe('required')
    const half2 = parseGuestForm(base({ emergency_phone: '9800000002' }), ctx)
    if (!half2.ok) expect(half2.errors['lead.emergency_name']).toBe('required')
  })
  it('keeps an extra guest mobile and rejects a bad one', () => {
    const occ = { client_key: 'o1', full_name: 'Friend', age: 8, id_type: 'aadhaar', id_last4: '4321' }
    const ok = parseGuestForm(base({}, [{ ...occ, mobile: '98000 00003' }]), { ...ctx, existingFronts: ['lead', 'o1'] })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.occupants[0].mobile).toBe('9800000003')
    const bad = parseGuestForm(base({}, [{ ...occ, mobile: 'abc' }]), ctx)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors['occupants.0.mobile']).toBe('invalidPhone')
  })
})
