'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'

// Who gets told when a guest writes or a form comes in (migration 058). Each person sets their own
// WhatsApp number and on/off duty; an admin also sets how long to wait before the
// message moves on to the next person.
interface Member { userId: string; name: string; role: string; alertPhone: string | null; available: boolean; isMe: boolean }

// Owner / admin: set every team member's WhatsApp number and duty in one place.
function TeamNumbers() {
  const t = useTranslations('GuestAlerts')
  const [members, setMembers] = useState<Member[] | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/team/alerts', { cache: 'no-store' })
        if (res.ok) setMembers((await res.json()).members ?? [])
      } catch {
        /* hidden */
      }
    })()
  }, [])

  async function save(m: Member) {
    setSaving(m.userId)
    try {
      const res = await fetch('/api/team/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: m.userId, alertPhone: m.alertPhone ?? '', available: m.available }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(j.error ?? t('failed'))
      else toast.success(t('saved'))
    } finally {
      setSaving(null)
    }
  }

  const patch = (id: string, p: Partial<Member>) => setMembers((cur) => (cur ?? []).map((m) => (m.userId === id ? { ...m, ...p } : m)))

  if (!members || members.length === 0) return null
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h4 className="text-sm font-semibold">{t('teamTitle')}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{t('teamHint')}</p>
      </div>
      <ul className="space-y-3">
        {members.map((m) => (
          <li key={m.userId} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">{m.name}{m.isMe ? ` (${t('you')})` : ''}</span>
              <span className="text-xs text-muted-foreground">{t(`roles.${m.role}`)}</span>
            </div>
            <Input
              inputMode="numeric"
              autoComplete="off"
              placeholder="966572657189"
              aria-label={`${m.name}: ${t('phone')}`}
              value={m.alertPhone ?? ''}
              onChange={(e) => patch(m.userId, { alertPhone: e.target.value })}
              className="min-h-11"
            />
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="size-5" checked={m.available} onChange={(e) => patch(m.userId, { available: e.target.checked })} />
              <span>{t('teamOnDuty')}</span>
            </label>
            <Button size="sm" className="min-h-10" onClick={() => void save(m)} disabled={saving === m.userId}>
              {saving === m.userId && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

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
        {isAdmin && <TeamNumbers />}
      </CardContent>
    </Card>
  )
}
