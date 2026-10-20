'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatIst } from '@/lib/stays/time'
import type { Difference, RunKind } from '@/lib/stays/checklist/logic'
import { ChecklistRunner, PhotoLink } from './checklist-runner'

// Checklists and damage reports inside the stay drawer. Caretakers see no money; owner/admin also get the
// estimated cost, "take off deposit" and settle/waive.
export interface DamageRow {
  id: string; report_no: number; title: string; description: string | null; status: 'open' | 'discussed' | 'settled' | 'waived'
  estimated_cost?: number | null; deposit_deduction?: number | null; applied_at?: string | null
  raised_by_name: string | null; created_at: string; photos: string[]
}
interface RunMeta { status: 'in_progress' | 'completed'; completed_at: string | null; completed_by_name: string | null }
const APPLY_ERR: Record<string, string> = {
  no_deposit_held: 'There is no deposit held for this stay.', already_applied: 'This damage was already taken off the deposit.',
  no_cost: 'Enter the estimated cost first.', exceeds_deposit: 'The cost is more than the deposit.',
}
const inr = (n: number) => `INR ${Number.isInteger(n) ? n : n.toFixed(2)}`

export function StayChecklists({ stayId, isAdmin, active, onChanged }: { stayId: string; isAdmin: boolean; active: boolean; onChanged?: () => void }) {
  const [runs, setRuns] = useState<Partial<Record<RunKind, RunMeta>>>({})
  const [diffs, setDiffs] = useState<Difference[]>([])
  const [damage, setDamage] = useState<DamageRow[]>([])
  const [runner, setRunner] = useState<RunKind | null>(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [cost, setCost] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/stays/${stayId}/checklists`, { cache: 'no-store' })
    if (!res.ok) return
    const j = await res.json()
    setRuns(j.runs ?? {}); setDiffs(j.differences ?? []); setDamage(j.damage ?? [])
  }, [stayId])
  useEffect(() => { void (async () => { await load() })() }, [load])

  async function addDamage() {
    setBusy(true)
    const res = await fetch(`/api/stays/${stayId}/damage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description: desc, estimated_cost: cost, run_kind: runs.checkout ? 'checkout' : runs.arrival ? 'arrival' : undefined }) })
    setBusy(false)
    if (!res.ok) { toast.error('Give the damage a short title (3+ letters).'); return }
    setAdding(false); setTitle(''); setDesc(''); setCost('')
    toast.success('Damage reported.'); await load()
  }
  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/damage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) { toast.error('Could not save.'); return }
    await load()
  }
  async function apply(id: string) {
    const res = await fetch(`/api/damage/${id}/apply-deposit`, { method: 'POST' })
    if (!res.ok) { toast.error(APPLY_ERR[(await res.json().catch(() => ({}))).error] ?? 'Could not apply.'); return }
    toast.success('Taken off the deposit.'); await load()
  }
  async function addPhoto(id: string, file: File) {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`/api/damage/${id}/photos`, { method: 'POST', body: fd })
    if (!res.ok) { toast.error('Could not upload the photo.'); return }
    await load()
  }

  const row = (kind: RunKind, label: string) => {
    const r = runs[kind]
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border p-2">
        <div className="text-sm">
          <p className="font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{r ? (r.status === 'completed' ? `Done ${formatIst(r.completed_at ?? '')}${r.completed_by_name ? ` by ${r.completed_by_name}` : ''}` : 'In progress') : 'Not started'}</p>
        </div>
        <Button size="sm" variant={r?.status === 'completed' ? 'outline' : 'default'} disabled={!active && !r} onClick={() => setRunner(kind)}>{r ? (r.status === 'completed' ? 'View' : 'Continue') : 'Start'}</Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="size-4" />Checklists and damage</h3>
      {row('arrival', 'Arrival checklist')}
      {row('checkout', 'Check-out inspection')}
      {diffs.length > 0 && (
        <div className="rounded-md bg-amber-50 p-2 text-sm dark:bg-amber-950/20">
          <p className="mb-1 font-medium">Changed since arrival</p>
          <ul className="space-y-0.5">
            {diffs.map((d) => (
              <li key={d.key}>
                {d.kind === 'new_issue' && <>New issue: {d.label}{d.note ? ` (${d.note})` : ''}</>}
                {d.kind === 'usage' && <>{d.label}: {d.arrival} to {d.checkout} (used {Math.round(((d.checkout ?? 0) - (d.arrival ?? 0)) * 100) / 100})</>}
                {d.kind === 'reading_dropped' && <>{d.label}: reading went down ({d.arrival} to {d.checkout}). Please check.</>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-2">
        {damage.map((d) => (
          <div key={d.id} className="rounded-md border p-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">#{d.report_no} {d.title}</p>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize">{d.status}</span>
            </div>
            {d.description && <p className="mt-0.5 text-muted-foreground">{d.description}</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">{d.raised_by_name ? `${d.raised_by_name}, ` : ''}{formatIst(d.created_at)}</p>
            {isAdmin && typeof d.estimated_cost === 'number' && <p className="mt-0.5">Estimated cost: {inr(d.estimated_cost)}{d.deposit_deduction ? ` (taken off deposit: ${inr(d.deposit_deduction)})` : ''}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {d.photos.map((p) => <PhotoLink key={p} id={p} />)}
              {d.status !== 'settled' && d.status !== 'waived' && (
                <label className="cursor-pointer rounded border px-2 py-0.5 text-xs underline">
                  Add photo
                  <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addPhoto(d.id, f) }} />
                </label>
              )}
              {d.status === 'open' && <Button size="sm" variant="outline" onClick={() => void patch(d.id, { status: 'discussed' })}>Mark discussed</Button>}
              {isAdmin && d.status !== 'settled' && d.status !== 'waived' && (
                <>
                  <Button size="sm" variant="outline" onClick={() => { const v = window.prompt('Estimated cost (INR)', String(d.estimated_cost ?? '')); if (v !== null) void patch(d.id, { estimated_cost: v }) }}>Set cost</Button>
                  {!d.applied_at && <Button size="sm" variant="outline" onClick={() => void apply(d.id)}>Take off deposit</Button>}
                  <Button size="sm" variant="outline" onClick={() => void patch(d.id, { status: 'settled' })}>Settled</Button>
                  <Button size="sm" variant="ghost" onClick={() => void patch(d.id, { status: 'waived' })}>Waive</Button>
                </>
              )}
            </div>
          </div>
        ))}
        {adding ? (
          <div className="space-y-2 rounded-md border p-2">
            <Input placeholder="What is damaged? (e.g. broken glass, bedroom 2)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input placeholder="Details (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            {isAdmin && <Input type="number" inputMode="decimal" placeholder="Estimated cost, INR (optional)" value={cost} onChange={(e) => setCost(e.target.value)} />}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void addDamage()}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Save report'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Report damage</Button>
        )}
      </div>
      {runner && <ChecklistRunner stayId={stayId} kind={runner} open onClose={() => { setRunner(null); void load() }} onChanged={() => { void load(); onChanged?.() }} />}
    </div>
  )
}
