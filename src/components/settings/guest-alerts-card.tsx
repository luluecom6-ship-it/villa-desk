'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'

// Who gets told when a guest writes (migration 058). Each person sets their own
// WhatsApp number and on/off duty; an admin also sets how long to wait before the
// message moves on to the next person.
export function GuestAlertsCard() {
  const t = useTranslations('GuestAlerts')
  const [loaded, setLoaded] = useState(false)
  const [phone, setPhone] = useState('')
  const [available, setAvailable] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [minutes, setMinutes] = useState('10')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/profile/alerts', { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        setPhone(j.alertPhone ?? '')
        setAvailable(j.available !== false)
        setIsAdmin(!!j.isAdmin)
        if (j.escalateAfterMinutes) setMinutes(String(j.escalateAfterMinutes))
        setLoaded(true)
      } catch {
        /* card stays hidden */
      }
    })()
  }, [])

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/profile/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertPhone: phone, available, ...(isAdmin ? { escalateAfterMinutes: Number(minutes) } : {}) }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error ?? t('failed'))
      else toast.success(t('saved'))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div>
          <h3 className="text-base font-semibold">{t('title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="size-5" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
          <span>{t('available')}</span>
        </label>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="alert-phone">{t('phone')}</label>
          <Input id="alert-phone" inputMode="numeric" autoComplete="tel" placeholder="919876543210" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-11" />
          <p className="text-xs text-muted-foreground">{t('phoneHint')}</p>
        </div>
        {isAdmin && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="esc-min">{t('minutes')}</label>
            <Input id="esc-min" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="min-h-11 w-28" />
            <p className="text-xs text-muted-foreground">{t('minutesHint')}</p>
          </div>
        )}
        <Button className="min-h-11" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t('save')}
        </Button>
      </CardContent>
    </Card>
  )
}
