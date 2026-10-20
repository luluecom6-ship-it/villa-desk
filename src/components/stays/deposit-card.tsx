'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DEPOSIT_STATUSES, refundAmount, type DepositStatus } from '@/lib/stays/deposits/logic'
import { formatIst } from '@/lib/stays/time'

// Security deposit for one stay. Owner and admin only (the API refuses everyone else).
// The app records the money; it never moves it.

const LABEL: Record<DepositStatus, string> = {
  not_required: 'Not required',
  pending: 'Pending',
  held: 'Held',
  refund_due: 'Refund due',
  refunded: 'Refunded',
  partly_deducted: 'Partly deducted',
}
const FIELD_ERR: Record<string, string> = {
  status: 'Choose a status.',
  amount: 'Enter a valid amount.',
  amountNeeded: 'Enter the deposit amount.',
  mode: 'Choose how it was paid.',
  receivedNeeded: 'Enter the date it was received.',
  deductionTooBig: 'The deduction is more than the deposit.',
  reasonNeeded: 'Give a reason for the deduction.',
  deductionNeeded: 'Enter the amount deducted.',
  refundedNeeded: 'Enter the date it was refunded.',
}
const inr = (n: number) => `INR ${Number.isInteger(n) ? n : n.toFixed(2)}`
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

interface Form {
  status: DepositStatus
  amount: string
  mode: string
  received_at: string
  reference_note: string
  deducted_amount: string
  deduction_reason: string
  refunded_at: string
  refund_reference: string
}
interface AuditRow { id: string; action: string; changed_by_name: string | null; created_at: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> }

export function DepositCard({ stayId, locked, onChanged }: { stayId: string; locked?: boolean; onChanged: () => void }) {
  const [form, setForm] = useState<Form | null>(null)
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/stays/${stayId}/deposit`, { cache: 'no-store' })
    if (!res.ok) return
    const j = await res.json()
    const d = j.deposit as Record<string, unknown> | null
    setForm({
      status: ((d?.status as DepositStatus) ?? j.defaultStatus) as DepositStatus,
      amount: d ? String(d.amount ?? '') : '',
      mode: (d?.mode as string) ?? '',
      received_at: day((d?.received_at as string) ?? null),
      reference_note: (d?.reference_note as string) ?? '',
      deducted_amount: d && Number(d.deducted_amount) > 0 ? String(d.deducted_amount) : '',
      deduction_reason: (d?.deduction_reason as string) ?? '',
      refunded_at: day((d?.refunded_at as string) ?? null),
      refund_reference: (d?.refund_reference as string) ?? '',
    })
    setAudit(j.audit ?? [])
    setDirty(false)
    setErrors({})
  }, [stayId])
  useEffect(() => { setForm(null); void load() }, [load])

  if (!form) return <div className="rounded-lg border border-border p-4"><Loader2 className="size-4 animate-spin" /></div>
  const set = (p: Partial<Form>) => { setForm({ ...form, ...p }); setDirty(true) }
  const amt = Number(form.amount || 0)
  const ded = Number(form.deducted_amount || 0)
  const err = (k: string) => errors[k] && <p className="text-xs text-red-600">{FIELD_ERR[errors[k]] ?? 'Check this field.'}</p>

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const res = await fetch(`/api/stays/${stayId}/deposit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: form.amount || 0, deducted_amount: form.deducted_amount || 0, mode: form.mode || null, received_at: form.received_at || null, refunded_at: form.refunded_at || null }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 400 && j.fields) { setErrors(j.fields); toast.error('Please fix the highlighted fields.'); return }
      if (!res.ok) { toast.error('Could not save the deposit.'); return }
      toast.success('Deposit saved.')
      await load()
      onChanged()
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Security deposit</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${form.status === 'refund_due' ? 'bg-amber-500/15 text-amber-700' : 'bg-muted text-muted-foreground'}`}>{LABEL[form.status]}</span>
      </div>
      <p className="text-xs text-muted-foreground">Records the money only. Visible to the owner and admins, never to caretakers. Every change is kept in the history below.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs">Status
          <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm" value={form.status} disabled={locked} onChange={(e) => set({ status: e.target.value as DepositStatus })}>
            {DEPOSIT_STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>{err('status')}
        </label>
        <label className="space-y-1 text-xs">Amount (INR)
          <Input className="min-h-11" inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.]/g, '') })} />{err('amount')}
        </label>
        <label className="space-y-1 text-xs">Paid by
          <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm" value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
            <option value="">-</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option>
          </select>{err('mode')}
        </label>
        <label className="space-y-1 text-xs">Received on
          <Input className="min-h-11" type="date" value={form.received_at} onChange={(e) => set({ received_at: e.target.value })} />{err('received_at')}
        </label>
      </div>
      <label className="block space-y-1 text-xs">Reference note
        <Input className="min-h-11" maxLength={300} value={form.reference_note} onChange={(e) => set({ reference_note: e.target.value })} placeholder="UPI ref, who took the cash..." />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs">Deducted (INR)
          <Input className="min-h-11" inputMode="decimal" value={form.deducted_amount} onChange={(e) => set({ deducted_amount: e.target.value.replace(/[^0-9.]/g, '') })} />{err('deducted_amount')}
        </label>
        <label className="space-y-1 text-xs">Deduction reason
          <Input className="min-h-11" maxLength={300} value={form.deduction_reason} onChange={(e) => set({ deduction_reason: e.target.value })} />{err('deduction_reason')}
        </label>
        <label className="space-y-1 text-xs">Refunded on
          <Input className="min-h-11" type="date" value={form.refunded_at} onChange={(e) => set({ refunded_at: e.target.value })} />{err('refunded_at')}
        </label>
        <label className="space-y-1 text-xs">Refund reference
          <Input className="min-h-11" maxLength={300} value={form.refund_reference} onChange={(e) => set({ refund_reference: e.target.value })} />
        </label>
      </div>
      {amt > 0 && <p className="text-sm">To refund: <span className="font-semibold">{inr(refundAmount({ amount: amt, deducted_amount: ded }))}</span></p>}
      <Button className="min-h-11" disabled={!dirty || saving} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />} Save deposit</Button>
      {audit.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">History ({audit.length})</summary>
          <ul className="mt-2 space-y-1">
            {audit.map((a) => {
              const o = a.old_values, n = a.new_values
              const changed = o ? Object.keys(n).filter((k) => !['created_at', 'id'].includes(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k])).join(', ') : 'created'
              return <li key={a.id}>{formatIst(a.created_at)} · {a.changed_by_name ?? 'System'} · {changed || 'saved'}</li>
            })}
          </ul>
        </details>
      )}
    </div>
  )
}
