'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Archive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// Archive proposal and approval (PDR 13.4). OWNER ONLY. At 70% storage the oldest, verified
// (Drive copy matches) files of stays checked out more than 90 days ago are listed. Nothing is removed
// until the owner presses Approve; the stay, guest and ID-review records always stay.
interface File { id: string; stayRef: string; checkoutAt: string; sizeBytes: number }
interface Data {
  summary: { usedBytes: number; limitBytes: number; percent: number; level: string; backedUp: number; files: number; archived: number }
  proposal: { files: File[]; freedBytes: number; projectedFraction: number }
}
const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`

export default function ArchivePage() {
  const [data, setData] = useState<Data | null>(null)
  const [denied, setDenied] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/stays/archive', { cache: 'no-store' })
    if (res.status === 403) { setDenied(true); return }
    if (res.ok) setData(await res.json())
  }, [])
  useEffect(() => { void load() }, [load])

  async function approve() {
    if (!data) return
    if (!window.confirm(`Move ${data.proposal.files.length} ID file(s) to Drive and remove them from storage? The Drive copy becomes the only copy.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/stays/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: data.proposal.files.map((f) => f.id) }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error('Could not archive.')
      else toast.success(`Archived ${j.archived}.${j.skipped ? ` Skipped ${j.skipped}.` : ''}${j.deleteFailed ? ` ${j.deleteFailed} could not be removed from storage; they are logged.` : ''}`)
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 pb-24 md:p-6">
      <Link href="/stays" className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4" /> Stays</Link>
      <div className="flex items-center gap-2"><Archive className="size-5" /><h1 className="text-xl font-semibold">Archive ID files to Drive</h1></div>
      {denied ? <p className="text-sm">Only the owner can approve archiving.</p> : !data ? <Loader2 className="size-4 animate-spin" /> : (
        <>
          <Card><CardContent className="space-y-1 pt-5 text-sm">
            <p>Storage is {data.summary.percent}% full. {data.summary.backedUp} of {data.summary.files} files have a verified Drive copy; {data.summary.archived} are already archived.</p>
            <p className="text-xs text-muted-foreground">Only files with a verified Drive copy, from stays checked out more than 90 days ago, can be archived. Nothing is removed until you approve.</p>
          </CardContent></Card>
          {data.proposal.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{data.summary.percent < 70 ? 'Storage is below 70%, so nothing is proposed.' : 'Nothing is eligible yet: files need a verified Drive copy and a stay checked out more than 90 days ago.'}</p>
          ) : (
            <>
              <p className="text-sm">{data.proposal.files.length} file(s), {mb(data.proposal.freedBytes)} to free. Storage would drop to about {Math.round(data.proposal.projectedFraction * 100)}%.</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {data.proposal.files.map((f) => <li key={f.id} className="flex justify-between gap-2 p-3"><span>{f.stayRef} · checked out {new Date(f.checkoutAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</span><span className="text-muted-foreground">{mb(f.sizeBytes)}</span></li>)}
              </ul>
              <Button className="min-h-11" disabled={busy} onClick={() => void approve()}>{busy && <Loader2 className="size-4 animate-spin" />} Approve and archive</Button>
            </>
          )}
        </>
      )}
    </div>
  )
}
