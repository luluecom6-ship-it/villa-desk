'use client'

import { CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AutomationState, IdStatus, StayStatus } from '@/lib/stays/types'

const BASE = 'inline-flex items-center gap-1 whitespace-nowrap'

export function StatusBadge({ status, checkoutAt }: { status: StayStatus; checkoutAt?: string }) {
  const t = useTranslations('Stays')
  // Past check-out time but not marked checked out yet: say so instead of "Registered".
  if (checkoutAt && (status === 'registered' || status === 'checked_in') && new Date(checkoutAt) <= new Date()) {
    return (
      <Badge variant="outline" className={cn(BASE, 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300')}>
        {t('status.checkout_due')}
      </Badge>
    )
  }
  const tone: Record<StayStatus, string> = {
    draft: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    registered: 'border-primary/40 bg-primary/10 text-primary',
    checked_in: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    checked_out: 'border-border bg-muted text-muted-foreground',
    cancelled: 'border-destructive/40 bg-destructive/10 text-destructive',
    sample: 'border-border bg-muted text-muted-foreground',
  }
  return (
    <Badge variant="outline" className={cn(BASE, tone[status])}>
      {t(`status.${status}`)}
    </Badge>
  )
}

export function AutomationBadge({ state }: { state: AutomationState }) {
  const t = useTranslations('Stays')
  if (state.on) {
    return (
      <Badge variant="outline" className={cn(BASE, 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300')}>
        {t('automation.on')}
      </Badge>
    )
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge variant="outline" className={cn(BASE, 'border-border bg-muted text-muted-foreground')}>
        {t('automation.off')}
      </Badge>
      {state.reason && (
        <span className="text-[11px] leading-tight text-muted-foreground">
          {t(`automation.reason.${state.reason}`)}
        </span>
      )}
    </span>
  )
}

export function IdBadge({ status }: { status: IdStatus }) {
  const t = useTranslations('Stays')
  const tone: Record<IdStatus, string> = {
    none: 'border-border bg-muted text-muted-foreground',
    pending: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    verified: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
  }
  return (
    <Badge variant="outline" className={cn(BASE, tone[status])}>
      {status === 'verified' && <CircleCheck className="size-3.5" aria-hidden />}
      {t(`idStatus.${status}`)}
    </Badge>
  )
}

export function FormBadge({ status }: { status: 'pending' | 'submitted' }) {
  const t = useTranslations('Stays')
  return (
    <Badge
      variant="outline"
      className={cn(
        BASE,
        status === 'submitted'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
      )}
    >
      {t(`formStatus.${status}`)}
    </Badge>
  )
}
