import { describe, expect, it } from 'vitest'
import { matchesFilter } from '../filters'
import { defaultDepositStatus, parseDeposit, refundAmount } from './logic'

const base = { status: 'held', amount: 5000, mode: 'upi', received_at: '2026-10-20T10:00:00Z' }

describe('deposit rules', () => {
  it('platform bookings default to Not required, direct ones to Pending', () => {
    expect(defaultDepositStatus('airbnb')).toBe('not_required')
    expect(defaultDepositStatus('booking_com')).toBe('not_required')
    expect(defaultDepositStatus('direct')).toBe('pending')
  })
  it('a held deposit needs an amount and the date received', () => {
    expect(parseDeposit({ ...base, amount: 0 })).toMatchObject({ ok: false, errors: { amount: 'amountNeeded' } })
    expect(parseDeposit({ ...base, received_at: '' })).toMatchObject({ ok: false, errors: { received_at: 'receivedNeeded' } })
    expect(parseDeposit(base).ok).toBe(true)
  })
  it('a deduction needs a reason and cannot exceed the deposit', () => {
    expect(parseDeposit({ ...base, deducted_amount: 500 })).toMatchObject({ ok: false, errors: { deduction_reason: 'reasonNeeded' } })
    expect(parseDeposit({ ...base, deducted_amount: 9000, deduction_reason: 'broken lamp' })).toMatchObject({ ok: false, errors: { deducted_amount: 'deductionTooBig' } })
    const ok = parseDeposit({ ...base, status: 'partly_deducted', deducted_amount: 500, deduction_reason: 'broken lamp' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(refundAmount(ok.value)).toBe(4500)
  })
  it('partly deducted needs a deduction; refunded needs the refund date', () => {
    expect(parseDeposit({ ...base, status: 'partly_deducted' })).toMatchObject({ ok: false, errors: { deducted_amount: 'deductionNeeded' } })
    expect(parseDeposit({ ...base, status: 'refunded' })).toMatchObject({ ok: false, errors: { refunded_at: 'refundedNeeded' } })
  })
  it('rejects a bad status, mode or a negative amount', () => {
    expect(parseDeposit({ ...base, status: 'x' }).ok).toBe(false)
    expect(parseDeposit({ ...base, mode: 'bitcoin' }).ok).toBe(false)
    expect(parseDeposit({ ...base, amount: -5 }).ok).toBe(false)
  })
})

describe('Deposit to refund filter', () => {
  const stay = (over: Record<string, unknown>) => ({ id: '1', status: 'checked_out', checkin_at: '2026-10-10T00:00:00Z', checkout_at: '2026-10-12T00:00:00Z', ...over }) as never
  it('lists refund-due deposits only', () => {
    expect(matchesFilter(stay({ deposit_status: 'refund_due' }), 'deposit_refund')).toBe(true)
    expect(matchesFilter(stay({ deposit_status: 'held' }), 'deposit_refund')).toBe(false)
    expect(matchesFilter(stay({}), 'deposit_refund')).toBe(false)
  })
})
