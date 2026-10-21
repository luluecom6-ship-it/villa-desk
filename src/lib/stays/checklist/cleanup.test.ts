import { describe, expect, it } from 'vitest'
import { eligiblePhotos, type Row } from './cleanup'

const NOW = new Date('2026-10-21T00:00:00Z')
const row = (id: string, o: Partial<Row> & { out?: string; st?: string; dmg?: string | null } = {}): Row => ({
  id, stay_id: 's', size_bytes: 100, storage_path: `p/${id}`,
  stays: { status: o.st ?? 'checked_out', checkout_at: o.out ?? '2026-07-01T00:00:00Z' },
  damage_reports: o.dmg === undefined || o.dmg === null ? null : { status: o.dmg },
})

describe('eligiblePhotos', () => {
  it('keeps recent, running, already-deleted and unsettled-damage photos', () => {
    const rows = [
      row('old'), row('recent', { out: '2026-09-15T00:00:00Z' }), row('running', { st: 'checked_in' }), row('done'),
      row('open', { dmg: 'open' }), row('talk', { dmg: 'discussed' }), row('settled', { dmg: 'settled' }), row('waived', { dmg: 'waived' }),
    ]
    expect(eligiblePhotos(rows, new Set(['done']), NOW).map((p) => p.id)).toEqual(['old', 'settled', 'waived'])
  })
  it('the 90-day line is exact', () => {
    expect(eligiblePhotos([row('a', { out: '2026-07-23T00:00:00Z' }), row('b', { out: '2026-07-22T00:00:00Z' })], new Set(), NOW).map((p) => p.id)).toEqual(['b'])
  })
})
