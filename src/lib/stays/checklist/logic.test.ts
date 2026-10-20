import { describe, expect, it } from 'vitest'
import { DEFAULT_ITEMS, deductionReason, diffRuns, parseAnswer, parseDamage, parseItems, unanswered, type ChecklistItem } from './logic'

const items: ChecklistItem[] = [
  { key: 'ac', section: 'Appliances', label: 'AC', type: 'check' },
  { key: 'tv', section: 'Appliances', label: 'TV', type: 'check' },
  { key: 'meter', section: 'Meters', label: 'Electricity', type: 'reading' },
]

describe('template', () => {
  it('the default list is valid and has unique keys', () => {
    const r = parseItems(DEFAULT_ITEMS)
    expect(r.ok).toBe(true)
    if (r.ok) expect(new Set(r.items.map((i) => i.key)).size).toBe(r.items.length)
  })
  it('new items get a unique slug, existing keys are kept', () => {
    const r = parseItems([{ key: 'ac', section: 'A', label: 'AC' }, { section: 'A', label: 'Fan' }, { section: 'A', label: 'Fan' }])
    expect(r.ok && r.items.map((i) => i.key)).toEqual(['ac', 'fan', 'fan-2'])
  })
  it('rejects empty, blank and oversized lists', () => {
    expect(parseItems([]).ok).toBe(false)
    expect(parseItems([{ section: 'A', label: ' ' }]).ok).toBe(false)
    expect(parseItems(Array.from({ length: 151 }, (_, i) => ({ section: 'A', label: `Item ${i}` }))).ok).toBe(false)
  })
})

describe('answers', () => {
  it('an issue needs a note; readings must be numbers', () => {
    expect(parseAnswer(items[0], { status: 'issue' })).toMatchObject({ ok: false, error: 'issueNeedsNote' })
    expect(parseAnswer(items[0], { status: 'issue', note: 'remote missing' }).ok).toBe(true)
    expect(parseAnswer(items[2], { reading: 'abc' }).ok).toBe(false)
    expect(parseAnswer(items[2], { reading: '1200.5' })).toMatchObject({ ok: true, value: { reading: 1200.5 } })
    expect(parseAnswer(items[0], { status: 'maybe' }).ok).toBe(false)
  })
  it('a run is complete only when every item is answered', () => {
    expect(unanswered(items, { ac: { status: 'ok' } }).map((i) => i.key)).toEqual(['tv', 'meter'])
    expect(unanswered(items, { ac: { status: 'ok' }, tv: { status: 'issue', note: 'x y z' }, meter: { reading: 10 } })).toEqual([])
  })
})

describe('check-out versus arrival', () => {
  it('flags new issues and meter readings', () => {
    const d = diffRuns(items, { ac: { status: 'ok' }, tv: { status: 'issue', note: 'old crack' }, meter: { reading: 100 } }, { ac: { status: 'issue', note: 'remote lost' }, tv: { status: 'issue', note: 'crack' }, meter: { reading: 160 } })
    expect(d.map((x) => `${x.key}:${x.kind}`)).toEqual(['ac:new_issue', 'meter:usage'])
    expect(d[1]).toMatchObject({ arrival: 100, checkout: 160 })
  })
  it('a lower reading at check-out is flagged', () => {
    const d = diffRuns([items[2]], { meter: { reading: 100 } }, { meter: { reading: 90 } })
    expect(d[0].kind).toBe('reading_dropped')
  })
})

describe('damage', () => {
  it('caretakers cannot set a cost; admins can', () => {
    expect(parseDamage({ title: 'Broken lamp', estimated_cost: 500 }, false)).toMatchObject({ ok: true, value: { estimated_cost: null } })
    expect(parseDamage({ title: 'Broken lamp', estimated_cost: 500 }, true)).toMatchObject({ ok: true, value: { estimated_cost: 500 } })
    expect(parseDamage({ title: 'x' }, true).ok).toBe(false)
    expect(parseDamage({ title: 'Broken lamp', estimated_cost: -1 }, true).ok).toBe(false)
  })
  it('deduction reason names the report', () => {
    expect(deductionReason(null, 7, 'Broken lamp')).toBe('Damage #7: Broken lamp')
    expect(deductionReason('Late checkout', 7, 'Broken lamp')).toBe('Late checkout; Damage #7: Broken lamp')
  })
})
