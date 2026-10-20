'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { ChecklistItem } from '@/lib/stays/checklist/logic'

// The villa's arrival / check-out checklist. Owner and admin edit it; checklists already started keep their own copy.
const ERR: Record<string, string> = { blank: 'Every item needs a section and a name (2+ letters).', empty: 'Keep at least one item.', tooMany: 'Too many items (150 max).' }

export function ChecklistTemplateCard({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!canEdit) return
    void (async () => {
      const res = await fetch('/api/checklists/template', { cache: 'no-store' })
      if (res.ok) setItems((await res.json()).items)
    })()
  }, [canEdit])
  if (!canEdit || !items) return null

  const set = (i: number, patch: Partial<ChecklistItem>) => setItems(items.map((it, n) => (n === i ? { ...it, ...patch } : it)))
  async function save() {
    setSaving(true)
    const res = await fetch('/api/checklists/template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
    setSaving(false)
    if (!res.ok) { toast.error(ERR[(await res.json().catch(() => ({}))).error] ?? 'Could not save.'); return }
    setItems((await res.json()).items)
    toast.success('Checklist saved. New checklists will use it.')
  }
  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <h2 className="text-sm font-semibold">Caretaker checklist</h2>
        <p className="text-xs text-muted-foreground">Used for the arrival checklist and the check-out inspection. Changing it does not affect checklists already started.</p>
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={`${it.key}:${i}`} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[9rem_1fr_7rem_auto]">
              <Input className="col-span-2 sm:col-span-1" aria-label="Section" placeholder="Section" value={it.section} onChange={(e) => set(i, { section: e.target.value })} />
              <Input className="col-span-2 sm:col-span-1" aria-label="Item" placeholder="Item" value={it.label} onChange={(e) => set(i, { label: e.target.value })} />
              <select className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="Type" value={it.type} onChange={(e) => set(i, { type: e.target.value === 'reading' ? 'reading' : 'check' })}>
                <option value="check">OK / Issue</option>
                <option value="reading">Meter reading</option>
              </select>
              <Button type="button" size="icon" variant="ghost" aria-label="Remove" onClick={() => setItems(items.filter((_, n) => n !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setItems([...items, { key: '', section: items.at(-1)?.section ?? 'Rooms', label: '', type: 'check' }])}><Plus className="mr-1 size-4" />Add item</Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Save checklist'}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
