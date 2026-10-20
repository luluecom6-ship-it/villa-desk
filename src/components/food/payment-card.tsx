'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

// UPI payment for food orders (owner / admin). Hidden for everyone else (the API refuses them).
export function PaymentCard() {
  const [upiId, setUpiId] = useState('')
  const [payee, setPayee] = useState('')
  const [sendQr, setSendQr] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/food/payment', { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        setUpiId(j.upiId); setPayee(j.payeeName); setSendQr(j.sendQr); setLoaded(true)
      } catch { /* hidden */ }
    })()
  }, [])
  if (!loaded) return null

  async function save() {
    setSaving(true)
    const res = await fetch('/api/food/payment', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upiId, payeeName: payee, sendQr }) })
    setSaving(false)
    if (!res.ok) { toast.error((await res.json().catch(() => ({}))).error ?? 'Could not save.'); return }
    toast.success('Payment details saved.')
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Payment (UPI)</h2>
      <Card><CardContent className="space-y-3 pt-5">
        <p className="text-xs text-muted-foreground">When a caretaker confirms a food order, the guest is sent a UPI QR for the total. The app only records payment; the caretaker marks an order paid by hand once the money arrives.</p>
        <Input className="min-h-11" placeholder="UPI ID, e.g. mahinoor@okhdfcbank" value={upiId} onChange={(e) => setUpiId(e.target.value)} autoCapitalize="none" />
        <Input className="min-h-11" placeholder="Name shown in the payment app (optional)" value={payee} maxLength={50} onChange={(e) => setPayee(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={sendQr} onChange={(e) => setSendQr(e.target.checked)} /> Send the QR automatically when an order is confirmed</label>
        <Button className="min-h-11" disabled={saving} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />} Save payment details</Button>
      </CardContent></Card>
    </section>
  )
}
