import { describe, expect, it } from 'vitest'
import { connectionTroubleReason, dailyLimit, dayKeyIn, hourIn, inWindow, shouldAutoPause } from './safety'

const D = (iso: string) => new Date(iso)

describe('warm-up limit (PDR 8.5)', () => {
  const start = D('2026-10-01T04:00:00Z')
  const at = (days: number) => new Date(start.getTime() + days * 86_400_000 + 3_600_000)
  it('20 a day through day 3, 40 through 7, 70 through 14, 100 through 21, then the maximum', () => {
    expect(dailyLimit(start, at(0), 500)).toBe(20)
    expect(dailyLimit(start, at(2), 500)).toBe(20)
    expect(dailyLimit(start, at(3), 500)).toBe(40)
    expect(dailyLimit(start, at(6), 500)).toBe(40)
    expect(dailyLimit(start, at(7), 500)).toBe(70)
    expect(dailyLimit(start, at(13), 500)).toBe(70)
    expect(dailyLimit(start, at(14), 500)).toBe(100)
    expect(dailyLimit(start, at(20), 500)).toBe(100)
    expect(dailyLimit(start, at(21), 500)).toBe(500)
  })
  it('never exceeds the configured maximum, and starts at 20 before the first send', () => {
    expect(dailyLimit(start, at(10), 50)).toBe(50)
    expect(dailyLimit(null, at(0), 500)).toBe(20)
    expect(dailyLimit(null, at(0), 10)).toBe(10)
  })
})

describe('sending hours in the property time zone', () => {
  it('09:00 to 20:00 Asia/Kolkata', () => {
    expect(hourIn('Asia/Kolkata', D('2026-10-18T03:30:00Z'))).toBe(9)
    expect(inWindow('Asia/Kolkata', D('2026-10-18T03:29:00Z'), 9, 20)).toBe(false)
    expect(inWindow('Asia/Kolkata', D('2026-10-18T03:30:00Z'), 9, 20)).toBe(true)
    expect(inWindow('Asia/Kolkata', D('2026-10-18T14:29:00Z'), 9, 20)).toBe(true)
    expect(inWindow('Asia/Kolkata', D('2026-10-18T14:30:00Z'), 9, 20)).toBe(false)
  })
  it('the day rolls over at local midnight, not UTC', () => {
    expect(dayKeyIn('Asia/Kolkata', D('2026-10-17T18:29:00Z'))).toBe('2026-10-17')
    expect(dayKeyIn('Asia/Kolkata', D('2026-10-17T18:31:00Z'))).toBe('2026-10-18')
  })
  it('an unknown zone falls back to Asia/Kolkata', () => {
    expect(hourIn('Not/AZone', D('2026-10-18T03:30:00Z'))).toBe(9)
  })
})

describe('auto-pause', () => {
  const f = { ok: false }, g = { ok: true }
  it('pauses at 4 failures in the last 5', () => {
    expect(shouldAutoPause([f, f, f, f, g])).toBe(true)
    expect(shouldAutoPause([f, f, f, f])).toBe(true)
    expect(shouldAutoPause([f, f, f, g, g])).toBe(false)
    expect(shouldAutoPause([f, f, f])).toBe(false)
  })
  it('401 (logged out) and 403 (refused) stop sending at once; other closes do not', () => {
    expect(connectionTroubleReason(401)).toBe('logged_out')
    expect(connectionTroubleReason('403')).toBe('refused_by_whatsapp')
    expect(connectionTroubleReason(428)).toBeNull()
    expect(connectionTroubleReason(undefined)).toBeNull()
  })
})
