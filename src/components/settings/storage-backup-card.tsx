'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useCan } from '@/hooks/use-can'
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
  const isOwner = useCan('transfer-ownership')
  const [photos, setPhotos] = useState<{ keepDays: number; count: number; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isOwner) return
    void (async () => {
      try {
        const res = await fetch('/api/stays/photo-cleanup', { cache: 'no-store' })
        if (res.ok) setPhotos(await res.json())
      } catch { /* hidden */ }
    })()
  }, [isOwner])
  async function cleanup() {
    if (!photos || !window.confirm(`Permanently delete ${photos.count} inspection / damage photo(s) (${mb(photos.bytes)}) from stays checked out more than ${photos.keepDays} days ago? There is no backup and this cannot be undone.`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/stays/photo-cleanup', { method: 'POST' })
      const j = res.ok ? await res.json() : null
      if (!j) { toast.error('Could not delete the photos.'); return }
      toast.success(`Deleted ${j.deleted} photo(s), freed ${mb(j.bytes)}${j.failed ? `; ${j.failed} could not be deleted` : ''}.`)
      setPhotos({ keepDays: photos.keepDays, count: j.remaining, bytes: 0 })
      const again = await fetch('/api/stays/photo-cleanup', { cache: 'no-store' })
      if (again.ok) setPhotos(await again.json())
    } finally {
      setBusy(false)
    }
  }
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
        {isOwner && photos && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Old inspection and damage photos</p>
            {photos.count > 0 ? (
              <>
                <p className="mt-1 text-muted-foreground">{photos.count} photo(s), {mb(photos.bytes)}, from stays checked out more than {photos.keepDays} days ago. Photos of damage that is still open are kept. No backup is made.</p>
                <Button variant="destructive" size="sm" className="mt-2" disabled={busy} onClick={() => void cleanup()}>Delete old photos</Button>
              </>
            ) : (
              <p className="mt-1 text-muted-foreground">Nothing older than {photos.keepDays} days to delete.</p>
            )}
          </div>
        )}
        <Link href="/stays/archive" className="inline-block text-sm font-medium underline">Review archive (owner)</Link>
      </CardContent>
    </Card>
  )
}
