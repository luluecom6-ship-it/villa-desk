// Security deposit rules (PDR section 9), pure and tested. The app records the money; it never moves it.

export const DEPOSIT_STATUSES = ['not_required', 'pending', 'held', 'refund_due', 'refunded', 'partly_deducted'] as const
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number]
export const DEPOSIT_MODES = ['upi', 'cash', 'bank_transfer'] as const
export type DepositMode = (typeof DEPOSIT_MODES)[number]

export interface DepositForm {
  status: DepositStatus
  amount: number
  mode: DepositMode | null
  received_at: string | null
  reference_note: string
  deducted_amount: number
  deduction_reason: string
  refunded_at: string | null
  refund_reference: string
}

/** Platform bookings default to Not required (the platform handles damage claims); direct ones to Pending. */
export function defaultDepositStatus(source: string): DepositStatus {
  return source === 'direct' || source === 'other' ? 'pending' : 'not_required'
}

export type DepositParse = { ok: true; value: DepositForm } | { ok: false; errors: Record<string, string> }

const money = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null
}
const text = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max)
const date = (v: unknown): string | null => {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Validate what staff typed. Error values are short keys the screen turns into words. */
export function parseDeposit(raw: unknown): DepositParse {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const status = b.status as DepositStatus
  if (!DEPOSIT_STATUSES.includes(status)) errors.status = 'status'
  const amount = money(b.amount)
  if (amount === null) errors.amount = 'amount'
  const deducted = money(b.deducted_amount)
  if (deducted === null) errors.deducted_amount = 'amount'
  const mode = b.mode ? (String(b.mode) as DepositMode) : null
  if (mode && !DEPOSIT_MODES.includes(mode)) errors.mode = 'mode'
  const reason = text(b.deduction_reason)
  if (Object.keys(errors).length) return { ok: false, errors }

  const amt = amount as number
  const ded = deducted as number
  if (ded > amt) errors.deducted_amount = 'deductionTooBig'
  if (ded > 0 && reason.length < 3) errors.deduction_reason = 'reasonNeeded'
  if (['held', 'refund_due', 'refunded', 'partly_deducted'].includes(status) && amt <= 0) errors.amount = 'amountNeeded'
  if (['held', 'refund_due', 'refunded', 'partly_deducted'].includes(status) && !date(b.received_at)) errors.received_at = 'receivedNeeded'
  if (status === 'partly_deducted' && ded <= 0) errors.deducted_amount = 'deductionNeeded'
  if (status === 'refunded' && !date(b.refunded_at)) errors.refunded_at = 'refundedNeeded'
  if (Object.keys(errors).length) return { ok: false, errors }

  return {
    ok: true,
    value: {
      status,
      amount: amt,
      mode,
      received_at: date(b.received_at),
      reference_note: text(b.reference_note),
      deducted_amount: ded,
      deduction_reason: reason,
      refunded_at: date(b.refunded_at),
      refund_reference: text(b.refund_reference),
    },
  }
}

/** Amount to give back: what was held minus deductions. */
export const refundAmount = (d: { amount: number; deducted_amount: number }) => Math.max(0, d.amount - d.deducted_amount)

export const needsRefund = (status: DepositStatus | null | undefined) => status === 'refund_due'
