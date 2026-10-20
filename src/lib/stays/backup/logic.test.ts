import { describe, expect, it } from 'vitest'
import { copyMatches, driveFileName, meter, proposeArchive, storageLimit } from './logic'

const GB = 1_073_741_824
const NOW = new Date('2026-10-20T00:00:00Z')
const c = (id: string, daysAgo: number, mb = 100) => ({ id, stayRef: id, checkoutAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), sizeBytes: mb * 1_048_576 })

describe('storage meter', () => {
  it('amber at 70%, red at 90%', () => {
    expect(meter(0.5 * GB, GB).level).toBe('ok')
    expect(meter(0.7 * GB, GB).level).toBe('amber')
    expect(meter(0.9 * GB, GB).level).toBe('red')
  })
  it('limit comes from the env, with a 1 GB default', () => {
    expect(storageLimit(undefined)).toBe(GB)
    expect(storageLimit('5000000')).toBe(5_000_000)
    expect(storageLimit('abc')).toBe(GB)
  })
})

describe('archive proposal', () => {
  it('proposes nothing below 70%', () => {
    expect(proposeArchive([c('a', 200)], 0.6 * GB, GB, NOW).files).toEqual([])
  })
  it('lists only stays older than 90 days, oldest first, until about 50%', () => {
    const files = [c('new', 30), c('b', 120), c('a', 400), c('d', 200)]
    const r = proposeArchive(files, 0.8 * GB, GB, NOW)
    expect(r.files.map((f) => f.id)).toEqual(['a', 'd', 'b']) // 'new' (30 days) never
    expect(r.projectedFraction).toBeLessThan(0.8)
  })
  it('stops once the projection reaches 50%', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`f${i}`, 200 + i, 100)) // 100 MB each
    const r = proposeArchive(many, 0.72 * GB, GB, NOW)
    expect((0.72 * GB - r.freedBytes) / GB).toBeLessThanOrEqual(0.5)
    expect(r.files.length).toBeLessThan(20)
  })
})

describe('copy verification', () => {
  const stored = { size_bytes: 1000, sha256: 'ab'.repeat(32) }
  it('needs the same size and checksum', () => {
    expect(copyMatches(stored, { size: 1000, sha256: 'AB'.repeat(32) })).toBe(true)
    expect(copyMatches(stored, { size: '1000', sha256: 'ab'.repeat(32) })).toBe(true)
    expect(copyMatches(stored, { size: 999, sha256: 'ab'.repeat(32) })).toBe(false)
    expect(copyMatches(stored, { size: 1000, sha256: 'cd'.repeat(32) })).toBe(false)
  })
  it('the Drive name carries no guest name', () => {
    expect(driveFileName({ stayRef: 'MS-2026-002', role: 'lead', side: 'front', id: '12345678-aaaa', contentType: 'image/jpeg' })).toBe('MS-2026-002_lead_front_12345678.jpg')
  })
})
