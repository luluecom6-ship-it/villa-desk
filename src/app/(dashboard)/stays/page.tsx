'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarCheck, Loader2, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCan } from '@/hooks/use-can'
import { cn } from '@/lib/utils'
import { formatIst } from '@/lib/stays/time'
import { STAY_FILTERS, type StayFilter } from '@/lib/stays/filters'
import {
  AutomationBadge,
  FormBadge,
  IdBadge,
  StatusBadge,
} from '@/components/stays/stay-badges'
import { StayDrawer, type DrawerStay } from '@/components/stays/stay-drawer'
import { StayFormDialog } from '@/components/stays/stay-form-dialog'
import { WhatsAppBanner } from '@/components/settings/whatsapp-banner'
import { HouseRulesPanel } from '@/components/stays/house-rules'

type ListStay = DrawerStay

export default function StaysPage() {
  const t = useTranslations('Stays')
  // Admin and above can create and edit registrations (PDR section 2).
  const isAdmin = useCan('edit-settings')

  const [filter, setFilter] = useState<StayFilter>('all')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [stays, setStays] = useState<ListStay[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setError(null)
    try {
      const params = new URLSearchParams({ filter })
      if (debounced.trim()) params.set('q', debounced.trim())
      const res = await fetch(`/api/stays?${params}`)
      const json = await res.json().catch(() => ({}))
      if (seq !== requestSeq.current) return // a newer request superseded this one
      if (!res.ok) {
        setError(json.error ?? t('toast.loadFailed'))
        return
      }
      setStays(json.stays ?? [])
      setCounts(json.counts ?? {})
    } catch {
      if (seq === requestSeq.current) {
        setError(t('toast.loadFailed'))
        toast.error(t('toast.loadFailed'))
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [filter, debounced, t])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  // Keep the list fresh without a reload: every 30 seconds while the tab is visible, and when it is focused again.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const id = setInterval(tick, 30_000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  const searching = debounced.trim().length > 0

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setNewOpen(true)} className="w-full sm:w-auto">
            <Plus className="size-4" />
            {t('newRegistration')}
          </Button>
        )}
      </div>

      {isAdmin && <WhatsAppBanner />}
      <HouseRulesPanel isAdmin={isAdmin} />

      <div className="space-y-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="bg-card pl-8"
            aria-label={t('searchPlaceholder')}
          />
        </div>

        {/* Filter chips: one scrollable row on phones. */}
        <div
          className={cn(
            '-mx-1 flex gap-2 overflow-x-auto px-1 pb-1',
            searching && 'pointer-events-none opacity-50',
          )}
          role="tablist"
          aria-label={t('filters.label')}
        >
          {STAY_FILTERS.filter((f) => f !== 'deposit_refund' || isAdmin).map((f) => {
            const active = f === filter
            return (
              <button
                key={f}
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f)}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {t(`filters.${f}`)}
                {counts[f] !== undefined && (
                  <span className={cn('ml-1.5 text-xs', active ? 'opacity-90' : 'opacity-70')}>
                    {counts[f]}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {searching && <p className="text-xs text-muted-foreground">{t('searchAllNote')}</p>}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : stays.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-14 text-center">
          <CalendarCheck className="size-8 text-muted-foreground" />
          <p className="font-medium">{searching ? t('empty.noMatches') : t('empty.title')}</p>
          {!searching && <p className="max-w-sm text-sm text-muted-foreground">{t('empty.hint')}</p>}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.reference')}</TableHead>
                  <TableHead>{t('columns.guest')}</TableHead>
                  <TableHead>{t('columns.mobile')}</TableHead>
                  <TableHead>{t('columns.checkin')}</TableHead>
                  <TableHead>{t('columns.checkout')}</TableHead>
                  <TableHead>{t('columns.form')}</TableHead>
                  <TableHead>{t('columns.id')}</TableHead>
                  <TableHead>{t('columns.automation')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stays.map((s) => (
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpenId(s.id)}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium">{s.stay_ref}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`source.${s.source}`)}
                        {s.external_booking_ref ? ` · ${s.external_booking_ref}` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{s.guest_name}</div>
                      <div className="mt-0.5">
                        <StatusBadge status={s.status} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {s.guest_phone ? `+${s.guest_phone}` : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatIst(s.checkin_at)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatIst(s.checkout_at)}</TableCell>
                    <TableCell>
                      <FormBadge status={s.form_status} />
                    </TableCell>
                    <TableCell>
                      <IdBadge status={s.id_status} />
                    </TableCell>
                    <TableCell>
                      <AutomationBadge state={s.automation} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Phone cards */}
          <ul className="space-y-3 md:hidden">
            {stays.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setOpenId(s.id)}
                  className="w-full rounded-xl border border-border bg-card p-3 text-left active:bg-muted"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{s.guest_name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{s.stay_ref}</div>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="mt-2 text-sm">
                    {formatIst(s.checkin_at)} → {formatIst(s.checkout_at)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {s.guest_phone ? `+${s.guest_phone}` : t('columns.noMobile')} · {t(`source.${s.source}`)}
                    {s.external_booking_ref ? ` · ${s.external_booking_ref}` : ''}
                  </div>
                  <div className="mt-2 flex flex-wrap items-start gap-1.5">
                    <FormBadge status={s.form_status} />
                    <IdBadge status={s.id_status} />
                    <AutomationBadge state={s.automation} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Mounted only while open so the form always starts fresh. */}
      {newOpen && (
        <StayFormDialog
          open
          onOpenChange={(o) => !o && setNewOpen(false)}
          onSaved={() => void load()}
        />
      )}

      <StayDrawer
        stayId={openId}
        isAdmin={isAdmin}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    </div>
  )
}
