'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { FoodTabs } from '@/components/food/food-tabs'

// Food menu settings: the dishes, prices (INR) and the menu picture guests receive.
interface Item { id: string | null; name: string; price: string; active: boolean }

export default function FoodMenuPage() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const loadMenu = useCallback(async () => {
    const res = await fetch('/api/food/items', { cache: 'no-store' })
    if (!res.ok) return
    const j = await res.json()
    setItems((j.items as { id: string; name: string; price: number; active: boolean }[]).map((i) => ({ id: i.id, name: i.name, price: String(i.price), active: i.active })))
    setImageUrl(j.imageUrl ?? null)
  }, [])

  useEffect(() => { void loadMenu() }, [loadMenu])

  const edit = (i: number, p: Partial<Item>) => { setItems((cur) => (cur ?? []).map((it, k) => (k === i ? { ...it, ...p } : it))); setDirty(true) }
  const move = (i: number, d: -1 | 1) => {
    setItems((cur) => {
      const a = [...(cur ?? [])]
      const j = i + d
      if (j < 0 || j >= a.length) return a
      ;[a[i], a[j]] = [a[j], a[i]]
      return a
    })
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/food/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: (items ?? []).filter((i) => i.name.trim()).map((i) => ({ id: i.id, name: i.name, price: Number(i.price || 0), active: i.active })) }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error ?? 'Could not save.')
      else { toast.success('Menu saved.'); setDirty(false); await loadMenu() }
    } finally { setSaving(false) }
  }

  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/food/image', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error ?? 'Could not upload.')
      else { setImageUrl(j.imageUrl); toast.success('Menu picture saved. Guests will receive it.') }
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function removeImage() {
    const res = await fetch('/api/food/image', { method: 'DELETE' })
    if (res.ok) { setImageUrl(null); toast.success('Menu picture removed.') } else toast.error('Could not remove it.')
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 pb-24 md:p-6">
      <FoodTabs active="menu" />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Menu picture</h2>
        <Card><CardContent className="space-y-3 pt-5">
          <p className="text-xs text-muted-foreground">Sent to the guest first when they choose Food, followed by the numbered list below. JPG, PNG or WebP, up to 4 MB.</p>
          {imageUrl && /* eslint-disable-next-line @next/next/no-img-element */ <img src={imageUrl} alt="Food menu" className="max-h-72 w-full rounded-md border border-border object-contain" />}
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
            <Button variant="outline" className="min-h-11" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} {imageUrl ? 'Replace picture' : 'Upload picture'}</Button>
            {imageUrl && <Button variant="ghost" className="min-h-11" onClick={() => void removeImage()}>Remove</Button>}
          </div>
        </CardContent></Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Menu and prices (INR)</h2>
        <Card><CardContent className="space-y-3 pt-5">
          <p className="text-xs text-muted-foreground">Guests order by sending the numbers. The order here is the numbering they see. A dish you switch off is hidden from guests but kept in old orders.</p>
          {items === null ? <Loader2 className="size-4 animate-spin" /> : items.map((it, i) => (
            <div key={it.id ?? `new-${i}`} className={cn('flex items-center gap-2', !it.active && 'opacity-50')}>
              <span className="w-6 shrink-0 text-right text-sm text-muted-foreground">{i + 1}.</span>
              <Input className="min-h-11 flex-1" value={it.name} placeholder="Dish name" maxLength={80} onChange={(e) => edit(i, { name: e.target.value })} aria-label={`Dish ${i + 1} name`} />
              <Input className="min-h-11 w-24" inputMode="decimal" value={it.price} placeholder="Price" onChange={(e) => edit(i, { price: e.target.value.replace(/[^0-9.]/g, '') })} aria-label={`Dish ${i + 1} price`} />
              <label className="flex items-center" title="Show to guests"><input type="checkbox" className="size-5" checked={it.active} onChange={(e) => edit(i, { active: e.target.checked })} aria-label={`Dish ${i + 1} shown to guests`} /></label>
              <div className="flex flex-col">
                <button type="button" className="p-0.5 text-muted-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-4" /></button>
                <button type="button" className="p-0.5 text-muted-foreground disabled:opacity-30" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-4" /></button>
              </div>
              {!it.id && <button type="button" className="p-1 text-muted-foreground" onClick={() => { setItems((cur) => (cur ?? []).filter((_, k) => k !== i)); setDirty(true) }} aria-label="Remove"><Trash2 className="size-4" /></button>}
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-11" onClick={() => { setItems((cur) => [...(cur ?? []), { id: null, name: '', price: '', active: true }]); setDirty(true) }}><Plus className="size-4" /> Add dish</Button>
            <Button className="min-h-11" disabled={!dirty || saving} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />} Save menu</Button>
          </div>
        </CardContent></Card>
      </section>
    </div>
  )
}
