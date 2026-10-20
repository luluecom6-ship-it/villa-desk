'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// ID file storage against the plan limit, and how many files have a verified Drive copy.
// Owner / admin only (the API refuses everyone else, so the card stays hidden for them).
interface Summary {
  usedBytes: number
  limitBytes: number
  percent: number
  level: 'ok' | 'amber' | 'red'
  files: number
  backedUp: number
  archived: number
  driveMissing: number
}
const mb = (b: number) => (b >= 1_073_741_824 ? `${(b / 1_073_741_824).toFixed(2)} GB` : `${(b / 1_048_576).toFixed(1)} MB`)

export function StorageBackupCard() {
  const [s, setS] = useState<Summary | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/stays/storage', { cache: 'no-store' })
        if (res.ok) setS(await res.json())
      } catch { /* hidden */ }
    })()
  }, [])
  if (!s) return null
  const bar = s.level === 'red' ? 'bg-red-500' : s.level === 'amber' ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <h2 className="text-sm font-semibold">Storage and backup</h2>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>ID files: {mb(s.usedBytes)} of {mb(s.limitBytes)}</span><span>{s.percent}%</span></div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.min(100, s.percent)}%` }} /></div>
        </div>
        <p className="text-sm">{s.backedUp} of {s.files} ID files have a verified copy in Drive{s.archived > 0 ? `, ${s.archived} archived (only in Drive)` : ''}.</p>
        {s.driveMissing > 0 && <p className="text-sm font-medium text-red-600">{s.driveMissing} Drive file(s) could not be found. Check the Drive folder.</p>}
        {s.level !== 'ok' && <p className="text-sm text-amber-700">Storage is getting full. The owner can approve moving old, backed-up files to Drive.</p>}
        <Link href="/stays/archive" className="inline-block text-sm font-medium underline">Review archive (owner)</Link>
      </CardContent>
    </Card>
  )
}
