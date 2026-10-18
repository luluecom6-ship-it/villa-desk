'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, PauseCircle, QrCode, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCan } from '@/hooks/use-can'

// Link the villa's WhatsApp number (PDR 8.3). Built for a phone in the
// caretaker's hand: one column, big buttons, nothing wider than 380 px.
// Polls the link state every 3 seconds while this screen is open.

type LinkStatus = 'not_linked' | 'waiting' | 'connected' | 'paused' | 'logged_out'

interface StatusPayload {
  serverReady: boolean
  linked: boolean
  status: LinkStatus
  qr?: string | null
  pairingCode?: string | null
  connectedNumber?: string | null
  pausedReason?: string | null
  sentToday?: number
  dailyLimit?: number
  settings?: { maxDaily: number; windowStartHour: number; windowEndHour: number; autoPause: boolean; timeZone: string }
}

const TONE: Record<LinkStatus, string> = {
  not_linked: 'bg-muted text-foreground',
  waiting: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  connected: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  paused: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100',
  logged_out: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100',
}

async function post(path: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, json }
}

export function formatPairingCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export function WhatsAppLink() {
  const t = useTranslations('WhatsAppLink')
  const isAdmin = useCan('edit-settings')
  const [data, setData] = useState<StatusPayload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [tab, setTab] = useState<'qr' | 'code'>('qr')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [maxDaily, setMaxDaily] = useState('100')
  const [startHour, setStartHour] = useState('9')
  const [endHour, setEndHour] = useState('20')
  const [autoPause, setAutoPause] = useState(true)
  const seeded = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/evolution/status', { cache: 'no-store' })
      if (!res.ok) {
        setLoadError(true)
        return
      }
      const json = (await res.json()) as StatusPayload
      setData(json)
      setLoadError(false)
      if (json.settings && !seeded.current) {
        seeded.current = true
        setMaxDaily(String(json.settings.maxDaily))
        setStartHour(String(json.settings.windowStartHour))
        setEndHour(String(json.settings.windowEndHour))
        setAutoPause(json.settings.autoPause)
      }
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 3000)
    return () => clearInterval(id)
  }, [isAdmin, load])

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>

  async function run(name: string, path: string, body?: unknown, okMessage?: string) {
    setBusy(name)
    try {
      const r = await post(path, body)
      if (!r.ok) toast.error(typeof r.json.error === 'string' ? r.json.error : t('failed'))
      else if (okMessage) toast.success(okMessage)
      await load()
      return r
    } finally {
      setBusy(null)
    }
  }

  const status: LinkStatus = data?.status ?? 'not_linked'
  const needsLink = status === 'not_linked' || status === 'waiting' || status === 'logged_out'
  const phoneDigits = phone.replace(/\D/g, '')

  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4 sm:mx-0">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {loadError && <p className="text-sm text-red-600">{t('loadError')}</p>}
      {data && !data.serverReady && (
        <div className="flex gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{t('serverNotReady')}</span>
        </div>
      )}

      <div className={`flex items-center gap-3 rounded-xl p-4 ${TONE[status]}`} role="status">
        {status === 'connected' ? <CheckCircle2 className="size-6" /> : status === 'paused' ? <PauseCircle className="size-6" /> : <Smartphone className="size-6" />}
        <div className="min-w-0">
          <p className="font-semibold">{t(`status.${status}`)}</p>
          {status === 'connected' && data?.connectedNumber && (
            <p className="truncate text-sm">+{data.connectedNumber}</p>
          )}
          {status === 'paused' && data?.pausedReason && (
            <p className="text-sm">{t.has(`reason.${data.pausedReason}`) ? t(`reason.${data.pausedReason}`) : t('reason.other')}</p>
          )}
        </div>
      </div>

      {data?.linked && (status === 'connected' || status === 'paused') && (
        <p className="text-sm text-muted-foreground">
          {t('usage', { sent: data.sentToday ?? 0, limit: data.dailyLimit ?? 0 })}
        </p>
      )}

      {needsLink && (
        <div className="space-y-3 rounded-xl border p-4">
          <div className="grid grid-cols-2 gap-2" role="tablist">
            {(['qr', 'code'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`min-h-11 rounded-lg border px-3 text-sm font-medium ${tab === k ? 'border-foreground bg-foreground text-background' : 'bg-background text-foreground'}`}
              >
                {t(k === 'qr' ? 'tabQr' : 'tabCode')}
              </button>
            ))}
          </div>

          {tab === 'qr' ? (
            <div className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t('qrStep1')}</li>
                <li>{t('qrStep2')}</li>
                <li>{t('qrStep3')}</li>
              </ol>
              {data?.qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.qr} alt={t('qrAlt')} className="mx-auto aspect-square w-full max-w-[300px] rounded-lg border bg-white p-2" />
              ) : (
                <div className="flex aspect-square w-full max-w-[300px] items-center justify-center rounded-lg border border-dashed text-muted-foreground sm:mx-auto">
                  <QrCode className="size-12" />
                </div>
              )}
              <Button className="min-h-11 w-full" disabled={busy !== null || !data?.serverReady} onClick={() => void run('connect', '/api/evolution/connect')}>
                {busy === 'connect' && <Loader2 className="size-4 animate-spin" />}
                {data?.qr ? t('newQr') : t('showQr')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('codeIntro')}</p>
              <label className="block text-sm font-medium" htmlFor="link-phone">{t('phoneLabel')}</label>
              <Input
                id="link-phone"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="919876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="min-h-11"
              />
              <Button
                className="min-h-11 w-full"
                disabled={busy !== null || !data?.serverReady || phoneDigits.length < 8}
                onClick={() => void run('code', '/api/evolution/connect', { phone: phoneDigits })}
              >
                {busy === 'code' && <Loader2 className="size-4 animate-spin" />}
                {t('getCode')}
              </Button>
              {data?.pairingCode && (
                <div className="rounded-lg bg-muted p-4 text-center">
                  <p className="font-mono text-3xl font-bold tracking-widest" aria-label={t('codeLabel')}>{formatPairingCode(data.pairingCode)}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('codeSteps')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {data?.linked && status === 'connected' && (
        <div className="grid gap-2">
          <Button variant="outline" className="min-h-11" disabled={busy !== null} onClick={() => void run('test', '/api/evolution/test', undefined, t('testSent'))}>
            {busy === 'test' && <Loader2 className="size-4 animate-spin" />}
            {t('sendTest')}
          </Button>
          <Button variant="outline" className="min-h-11" disabled={busy !== null} onClick={() => void run('pause', '/api/evolution/pause', { paused: true })}>
            {t('pause')}
          </Button>
        </div>
      )}

      {data?.linked && status === 'paused' && (
        <Button className="min-h-11 w-full" disabled={busy !== null} onClick={() => void run('resume', '/api/evolution/pause', { paused: false }, t('resumed'))}>
          {busy === 'resume' && <Loader2 className="size-4 animate-spin" />}
          {t('resume')}
        </Button>
      )}

      {data?.linked && (status === 'connected' || status === 'paused') && (
        <>
          <details className="rounded-xl border p-4">
            <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem]">{t('safetyTitle')}</summary>
            <div className="mt-2 space-y-3">
              <p className="text-sm text-muted-foreground">{t('safetyIntro')}</p>
              <label className="block text-sm font-medium" htmlFor="max-daily">{t('maxDaily')}</label>
              <Input id="max-daily" inputMode="numeric" value={maxDaily} onChange={(e) => setMaxDaily(e.target.value)} className="min-h-11" />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm font-medium" htmlFor="start-hour">{t('startHour')}</label>
                  <Input id="start-hour" inputMode="numeric" value={startHour} onChange={(e) => setStartHour(e.target.value)} className="min-h-11" />
                </div>
                <div>
                  <label className="block text-sm font-medium" htmlFor="end-hour">{t('endHour')}</label>
                  <Input id="end-hour" inputMode="numeric" value={endHour} onChange={(e) => setEndHour(e.target.value)} className="min-h-11" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('timeZone', { zone: data.settings?.timeZone ?? 'Asia/Kolkata' })}</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={autoPause} onChange={(e) => setAutoPause(e.target.checked)} className="size-5" />
                {t('autoPause')}
              </label>
              <Button
                className="min-h-11 w-full"
                disabled={busy !== null}
                onClick={() =>
                  void run('settings', '/api/evolution/settings', { maxDaily: Number(maxDaily), windowStartHour: Number(startHour), windowEndHour: Number(endHour), autoPause }, t('saved'))
                }
              >
                {t('save')}
              </Button>
            </div>
          </details>

          <Button
            variant="outline"
            className="min-h-11 w-full text-red-700"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('logoutConfirm'))) void run('logout', '/api/evolution/logout', undefined, t('loggedOut'))
            }}
          >
            {t('logout')}
          </Button>
        </>
      )}

      {status === 'logged_out' && <p className="text-sm text-muted-foreground">{t('relinkHint')}</p>}
    </div>
  )
}
