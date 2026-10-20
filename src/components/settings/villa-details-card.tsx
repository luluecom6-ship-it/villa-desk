'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'

// The villa's own details that go into guest WhatsApp messages. Owner / admin only.
// Without the address, WiFi and lock details, caretaker phone and review link, the matching
// guest messages wait instead of going out with a gap in them.
interface Details {
  name: string
  address: string
  map_url: string
  directions: string
  access_instructions: string
  caretaker_phone: string
  review_url: string
  default_checkin_time: string
  default_checkout_time: string
  deposit_refund_days: number
}

const area = 'min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function VillaDetailsCard() {
  const [d, setD] = useState<Details | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/property', { cache: 'no-store' })
        if (res.ok) setD((await res.json()).property)
      } catch {
        /* hidden for non-admins */
      }
    })()
  }, [])

  if (!d) return null
  const set = (p: Partial<Details>) => setD({ ...d, ...p })

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/property', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error ?? 'Could not save.')
      else toast.success('Villa details saved. Waiting messages will go out.')
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, hint: string | null, node: React.ReactNode) => (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {node}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <h3 className="text-sm font-semibold">Villa details</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These go into the messages guests receive on WhatsApp (arrival information, WiFi and lock details, check-out reminder, review request). A message that needs a missing detail waits until you add it.
          </p>
        </div>
        {field('Villa name', null, <Input className="min-h-11" value={d.name} onChange={(e) => set({ name: e.target.value })} />)}
        {field('Address', 'Sent the day before check-in.', <textarea className={area} value={d.address} onChange={(e) => set({ address: e.target.value })} />)}
        {field('Map link', 'A Google Maps link.', <Input className="min-h-11" inputMode="url" value={d.map_url} onChange={(e) => set({ map_url: e.target.value })} />)}
        {field('Directions', 'Optional: landmarks, parking.', <textarea className={area} value={d.directions} onChange={(e) => set({ directions: e.target.value })} />)}
        {field('WiFi and lock / gate details', 'Sent on the check-in morning, only after every adult ID is approved. Include the WiFi name and password and how to open the gate and door.', <textarea className={`${area} min-h-32`} value={d.access_instructions} onChange={(e) => set({ access_instructions: e.target.value })} />)}
        {field("Caretaker's phone", 'With country code, e.g. 919876543210. Shown to the guest to call.', <Input className="min-h-11" inputMode="numeric" placeholder="919876543210" value={d.caretaker_phone} onChange={(e) => set({ caretaker_phone: e.target.value })} />)}
        <div className="grid grid-cols-2 gap-3">
          {field('Check-in time', null, <Input className="min-h-11" type="time" value={d.default_checkin_time} onChange={(e) => set({ default_checkin_time: e.target.value })} />)}
          {field('Check-out time', null, <Input className="min-h-11" type="time" value={d.default_checkout_time} onChange={(e) => set({ default_checkout_time: e.target.value })} />)}
        </div>
        {field('Review link', 'Sent after check-out.', <Input className="min-h-11" inputMode="url" value={d.review_url} onChange={(e) => set({ review_url: e.target.value })} />)}
        {field('Deposit refund (working days)', null, <Input className="min-h-11" type="number" min={0} max={60} value={d.deposit_refund_days} onChange={(e) => set({ deposit_refund_days: Number(e.target.value) })} />)}
        <Button className="min-h-11" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save villa details
        </Button>
      </CardContent>
    </Card>
  )
}
