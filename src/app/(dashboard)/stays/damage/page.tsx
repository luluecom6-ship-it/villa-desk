'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { PhotoLink } from '@/components/stays/checklist-runner'
import { formatIst } from '@/lib/stays/time'

// All damage reports across stays. Caretakers see the reports without any money; owner/admin also see the cost.
interface Report {
  id: string; report_no: number; title: string; description: string | null; status: string
  estimated_cost?: number | null; deposit_deduction?: number | null
  raised_by_name: string | null; created_at: string; photos: string[]; stays: { stay_ref: string; guest_name: string | null } | null
}
const FILTERS = ['', 'open', 'discussed', 'settled', 'waived']

export default function DamagePage() {
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<Report[] | null>(null)
  const [canSeeCost, setCanSeeCost] = useState(false)
  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/damage${status ? `?status=${status}` : ''}`, { cache: 'no-store' })
      if (res.ok) { const j = await res.json(); setRows(j.reports); setCanSeeCost(!!j.canSeeCost) }
    })()
  }, [status])
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <Link href="/stays" className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4" />Stays</Link>
      <h1 className="text-xl font-semibold">Damage reports</h1>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f} type="button" onClick={() => setStatus(f)} className={`rounded-full border px-3 py-1 text-sm capitalize ${status === f ? 'bg-primary text-primary-foreground' : ''}`}>{f || 'All'}</button>
        ))}
      </div>
      {rows?.length === 0 && <p className="text-sm text-muted-foreground">No damage reports.</p>}
      {rows?.map((r) => (
        <Card key={r.id}>
          <CardContent className="space-y-1 pt-4 text-sm">
            <div className="flex justify-between gap-2"><p className="font-medium">#{r.report_no} {r.title}</p><span className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize">{r.status}</span></div>
            <p className="text-xs text-muted-foreground">{r.stays?.stay_ref}{r.stays?.guest_name ? `, ${r.stays.guest_name}` : ''} · {formatIst(r.created_at)}{r.raised_by_name ? ` · ${r.raised_by_name}` : ''}</p>
            {r.description && <p>{r.description}</p>}
            {canSeeCost && typeof r.estimated_cost === 'number' && <p>Estimated cost: INR {r.estimated_cost}{r.deposit_deduction ? ` (taken off deposit: INR ${r.deposit_deduction})` : ''}</p>}
            <div className="flex flex-wrap gap-2">{r.photos.map((p) => <PhotoLink key={p} id={p} />)}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
