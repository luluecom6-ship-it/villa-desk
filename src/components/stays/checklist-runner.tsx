'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Camera, Check, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { isAnswered, unanswered, type Answers, type ChecklistItem, type RunKind } from '@/lib/stays/checklist/logic'

// Mobile-first checklist for the caretaker: tap OK / Issue per item, type meter readings, add photos.
// Every tap is saved straight away. Finishing locks the checklist (nothing can be edited afterwards).
interface Run { status: 'in_progress' | 'completed'; template_snapshot: ChecklistItem[]; answers: Answers; photos: Record<string, string[]> }

const TITLE: Record<RunKind, string> = { arrival: 'Arrival checklist', checkout: 'Check-out inspection' }
const ERR: Record<string, string> = {
  issueNeedsNote: 'Describe the issue first (a few words).',
  reading: 'Enter a valid number.',
  completed: 'This checklist is already finished.',
  incomplete: 'Some items are not answered yet.',
  file_type: 'Only photos (JPG, PNG, WebP) are allowed.',
  file_size: 'That photo is too large.',
  too_many: 'Too many photos on this item.',
}

export function ChecklistRunner({ stayId, kind, open, onClose, onChanged }: { stayId: string; kind: RunKind; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [uploadKey, setUploadKey] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    let res = await fetch(`/api/stays/${stayId}/checklists`, { cache: 'no-store' })
    if (!res.ok) return
    let r = ((await res.json()).runs?.[kind] ?? null) as Run | null
    if (!r) {
      const st = await fetch(`/api/stays/${stayId}/checklists/${kind}`, { method: 'POST' })
      if (!st.ok) { toast.error('Could not start the checklist.'); return }
      res = await fetch(`/api/stays/${stayId}/checklists`, { cache: 'no-store' })
      r = ((await res.json()).runs?.[kind] ?? null) as Run | null
    }
    if (r) {
      setRun(r)
      setNotes((n) => ({ ...Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.note ?? ''])), ...n }))
    }
  }, [stayId, kind])
  useEffect(() => { if (open) void (async () => { await load() })() }, [open, load])

  const locked = run?.status === 'completed'
  const sections = useMemo(() => {
    const m = new Map<string, ChecklistItem[]>()
    for (const i of run?.template_snapshot ?? []) m.set(i.section, [...(m.get(i.section) ?? []), i])
    return [...m.entries()]
  }, [run])
  const left = run ? unanswered(run.template_snapshot, run.answers).length : 0

  async function save(item: ChecklistItem, answer: Record<string, unknown>) {
    // Show the change at once; the server saves in the background and we roll back only if it refuses.
    const before = run
    setRun((r) => (r ? { ...r, answers: { ...r.answers, [item.key]: { ...r.answers[item.key], ...(answer as Answers[string]) } } } : r))
    const res = await fetch(`/api/stays/${stayId}/checklists/${kind}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: item.key, answer }) })
    if (!res.ok) {
      setRun(before)
      toast.error(ERR[(await res.json().catch(() => ({}))).error] ?? 'Could not save.')
      return false
    }
    return true
  }
  async function finish() {
    setBusy('finish')
    const res = await fetch(`/api/stays/${stayId}/checklists/${kind}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ complete: true }) })
    setBusy(null)
    if (!res.ok) { toast.error(ERR[(await res.json().catch(() => ({}))).error] ?? 'Could not finish.'); return }
    toast.success('Checklist finished.')
    onChanged()
    onClose()
  }
  async function upload(file: File) {
    if (!uploadKey) return
    const fd = new FormData()
    fd.append('file', file)
    fd.append('key', uploadKey)
    setBusy(uploadKey)
    const res = await fetch(`/api/stays/${stayId}/checklists/${kind}/photos`, { method: 'POST', body: fd })
    setBusy(null)
    if (!res.ok) { toast.error(ERR[(await res.json().catch(() => ({}))).error] ?? 'Could not upload the photo.'); return }
    const j = await res.json().catch(() => null)
    if (j?.photo_id) setRun((r) => (r ? { ...r, photos: { ...r.photos, [uploadKey]: [...(r.photos[uploadKey] ?? []), j.photo_id] } } : r))
    else await load()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-full max-w-lg overflow-y-auto p-4 sm:p-6">
        <DialogHeader><DialogTitle>{TITLE[kind]}</DialogTitle></DialogHeader>
        {!run ? <Loader2 className="mx-auto size-5 animate-spin" /> : (
          <div className="space-y-5">
            {locked && <p className="rounded-md bg-muted p-2 text-sm">This checklist is finished and locked.</p>}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
            {sections.map(([section, items]) => (
              <div key={section}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section}</h3>
                <ul className="space-y-2">
                  {items.map((it) => {
                    const a = run.answers[it.key]
                    const photos = run.photos[it.key] ?? []
                    const issue = a?.status === 'issue'
                    return (
                      <li key={it.key} className={cn('rounded-md border p-3', issue ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : isAnswered(it, a) ? 'border-emerald-300' : 'border-border')}>
                        <p className="text-sm font-medium">{it.label}</p>
                        {it.type === 'check' ? (
                          <div className="mt-2 flex gap-2">
                            <Button type="button" size="sm" variant={a?.status === 'ok' ? 'default' : 'outline'} disabled={locked} onClick={() => void save(it, { status: 'ok', note: '' })}><Check className="mr-1 size-4" />OK</Button>
                            <Button type="button" size="sm" variant={issue ? 'destructive' : 'outline'} disabled={locked} onClick={() => { if (!issue) setNotes((n) => ({ ...n, [it.key]: n[it.key] ?? '' })); void save(it, { status: 'issue', note: notes[it.key] || a?.note || 'Issue' }) }}><TriangleAlert className="mr-1 size-4" />Issue</Button>
                          </div>
                        ) : (
                          <Input className="mt-2" type="number" inputMode="decimal" disabled={locked} placeholder="Reading" defaultValue={a?.reading ?? ''}
                            onBlur={(e) => { if (e.target.value !== String(a?.reading ?? '')) void save(it, { reading: e.target.value === '' ? null : e.target.value }) }} />
                        )}
                        {issue && !locked && (
                          <Input className="mt-2" placeholder="What is wrong?" value={notes[it.key] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [it.key]: e.target.value }))}
                            onBlur={() => { if ((notes[it.key] ?? '').trim().length >= 3 && notes[it.key] !== a?.note) void save(it, { status: 'issue', note: notes[it.key] }) }} />
                        )}
                        {issue && locked && a?.note && <p className="mt-1 text-sm">{a.note}</p>}
                        <div className="mt-2 flex items-center gap-2">
                          {!locked && photos.length < 5 && (
                            <Button type="button" size="sm" variant="ghost" disabled={busy === it.key} onClick={() => { setUploadKey(it.key); fileRef.current?.click() }}><Camera className="mr-1 size-4" />Photo</Button>
                          )}
                          {photos.map((pid) => <PhotoLink key={pid} id={pid} />)}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
            {!locked && (
              <div className="sticky bottom-0 -mx-4 border-t bg-background p-3 sm:-mx-6">
                <Button className="w-full" disabled={left > 0 || busy === 'finish'} onClick={() => void finish()}>
                  {busy === 'finish' ? <Loader2 className="size-4 animate-spin" /> : left > 0 ? `${left} item${left === 1 ? '' : 's'} left` : 'Finish checklist'}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PhotoLink({ id }: { id: string }) {
  async function open() {
    const res = await fetch(`/api/checklist-photos/${id}/url`, { method: 'POST', cache: 'no-store' })
    const j = res.ok ? await res.json() : null
    if (j?.url) window.open(j.url, '_blank', 'noopener')
    else toast.error('Could not open the photo.')
  }
  return <button type="button" onClick={() => void open()} className="rounded border px-2 py-0.5 text-xs underline">View photo</button>
}
