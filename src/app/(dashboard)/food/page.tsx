'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { FoodTabs } from '@/components/food/food-tabs'

// Food orders. Guests order by sending item numbers on WhatsApp; an order waits here (and on the
// caretaker's WhatsApp) until someone approves it. The menu itself is on /food/menu.
interface Order {
  id: string
  orderNo: number
  guestName: string | null
  items: { name: string; price: number; qty: number }[]
  total: number
  status: 'pending' | 'confirmed' | 'declined'
  decidedByName: string | null
  declineReason: string | null
  createdAt: string
}

const inr = (n: number) => `INR ${Number.isInteger(n) ? n : n.toFixed(2)}`
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

export default function FoodPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const loadOrders = useCallback(async () => {
    const res = await fetch('/api/food/orders', { cache: 'no-store' })
    if (res.ok) setOrders((await res.json()).orders ?? [])
  }, [])

  useEffect(() => {
    void loadOrders()
    const id = setInterval(() => { if (document.visibilityState === 'visible') void loadOrders() }, 20_000)
    return () => clearInterval(id)
  }, [loadOrders])

  async function decide(o: Order, decision: 'confirmed' | 'declined') {
    let reason: string | undefined
    if (decision === 'declined') {
      const r = window.prompt('Why can the order not be taken? (the guest will see this, optional)')
      if (r === null) return
      reason = r
    }
    setBusy(o.id)
    try {
      const res = await fetch('/api/food/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.id, decision, reason }) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error === 'already_decided' ? 'Someone already answered this order.' : 'Could not update the order.')
      else if (j.guestMessage !== 'sent') toast.warning('Saved, but the guest could not be messaged just now. Please tell them by hand.')
      else toast.success(decision === 'confirmed' ? 'Confirmed. The guest has been told.' : 'Declined. The guest has been told.')
      await loadOrders()
    } finally { setBusy(null) }
  }

  const pending = orders.filter((o) => o.status === 'pending')
  const done = orders.filter((o) => o.status !== 'pending')

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 pb-24 md:p-6">
      <FoodTabs active="orders" />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Orders waiting {pending.length > 0 && <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">{pending.length}</span>}</h2>
        {pending.length === 0 ? <p className="text-sm text-muted-foreground">No orders waiting. New orders from guests appear here and on the caretaker&apos;s WhatsApp.</p> : pending.map((o) => (
          <Card key={o.id}><CardContent className="space-y-2 pt-5">
            <div className="flex items-center justify-between gap-2 text-sm"><span className="font-semibold">F{o.orderNo} · {o.guestName ?? 'Guest'}</span><span className="text-xs text-muted-foreground">{when(o.createdAt)}</span></div>
            <ul className="text-sm">{o.items.map((l, k) => <li key={k}>{l.qty} × {l.name} - {inr(l.price * l.qty)}</li>)}</ul>
            <div className="text-sm font-semibold">Total {inr(o.total)}</div>
            <div className="flex gap-2">
              <Button className="min-h-11 flex-1" disabled={busy === o.id} onClick={() => void decide(o, 'confirmed')}>{busy === o.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Approve</Button>
              <Button variant="outline" className="min-h-11 flex-1" disabled={busy === o.id} onClick={() => void decide(o, 'declined')}><X className="size-4" /> Decline</Button>
            </div>
          </CardContent></Card>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Earlier orders</h2>
        {done.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : done.map((o) => (
          <div key={o.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">F{o.orderNo} · {o.guestName ?? 'Guest'}</span><span className={cn('text-xs font-medium', o.status === 'confirmed' ? 'text-emerald-600' : 'text-red-600')}>{o.status === 'confirmed' ? 'Confirmed' : 'Declined'}{o.decidedByName ? ` by ${o.decidedByName}` : ''}</span></div>
            <div className="text-xs text-muted-foreground">{o.items.map((l) => `${l.qty} × ${l.name}`).join(', ')} · {inr(o.total)} · {when(o.createdAt)}</div>
            {o.declineReason && <div className="text-xs text-muted-foreground">Reason: {o.declineReason}</div>}
          </div>
        ))}
      </section>
    </div>
  )
}
