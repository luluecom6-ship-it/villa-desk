'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, CircleCheck, Copy, ExternalLink, Eye, Loader2, Pencil, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatIst } from '@/lib/stays/time'
import type { AutomationState, IdStatus, StayRow, StayGuestSummary } from '@/lib/stays/types'
import { AutomationBadge, FormBadge, IdBadge, StatusBadge } from './stay-badges'
import { StayFormDialog, type SavedStay } from './stay-form-dialog'
import { StaffIdUpload } from './staff-id-upload'
import { useCan } from '@/hooks/use-can'
import { DepositCard } from './deposit-card'

export type DrawerStay = Omit<StayRow, 'form_token'> & {
  automation: AutomationState
  id_status: IdStatus
  form_url?: string
  stay_guests?: StayGuestSummary[]
}

interface Detail {
  stay: DrawerStay
  acceptance: {
    typed_name: string
    accepted_at: string
    ip_address: string | null
    house_rules_versions: { version: number } | { version: number }[] | null
  } | null
  documents: Array<{ id: string; guest_id: string; side: string; content_type: string; size_bytes: number }>
  reviews?: Array<{ id: string; guest_id: string; action: 'approved' | 'rejected'; reason: string | null; reviewer_name: string | null; created_at: string }>
  messages?: Array<{ message_key: string; due_at: string; status: string; sent_at: string | null; attempts: number; last_error: string | null }>
}

interface Props {
  stayId: string | null
  isAdmin: boolean
  onClose: () => void
  /** Called after any change so the list refreshes. */
  onChanged: () => void
}

export function StayDrawer({ stayId, isAdmin, onClose, onChanged }: Props) {
  const t = useTranslations('Stays')
  // Caretakers (agent) and above may view and attach ID files; only admins review them.
  const canIds = useCan('send-messages')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [phoneDraft, setPhoneDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [viewer, setViewer] = useState<{ url: string; contentType: string; label: string } | null>(null)
  const [openingDoc, setOpeningDoc] = useState<string | null>(null)
  const [rejectFor, setRejectFor] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [resending, setResending] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!stayId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/stays/${stayId}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? t('toast.loadFailed'))
        setDetail(null)
        return
      }
      setDetail(json as Detail)
      setPhoneDraft('')
    } catch {
      setError(t('toast.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [stayId, t])

  useEffect(() => {
    setDetail(null)
    if (stayId) void load()
  }, [stayId, load])

  async function patch(body: Record<string, unknown>, successMessage?: string): Promise<boolean> {
    if (!stayId) return false
    setBusy(true)
    try {
      const res = await fetch(`/api/stays/${stayId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const firstField = json.fields ? Object.values(json.fields as Record<string, string>)[0] : null
        toast.error(firstField ?? json.error ?? t('toast.saveFailed'))
        return false
      }
      if (successMessage) toast.success(successMessage)
      await load()
      onChanged()
      return true
    } catch {
      toast.error(t('toast.saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  // One click = one signed link = one logged open (PDR 13.3). The link lives
  // 60 seconds, so it is requested only when the person asks to view.
  async function openDocument(docId: string, label: string) {
    if (!stayId) return
    setOpeningDoc(docId)
    try {
      const res = await fetch(`/api/stays/${stayId}/documents/${docId}/url`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.url) {
        toast.error(json.error ?? t('toast.documentFailed'))
        return
      }
      setViewer({ url: json.url, contentType: json.content_type ?? '', label })
    } catch {
      toast.error(t('toast.documentFailed'))
    } finally {
      setOpeningDoc(null)
    }
  }

  async function review(guestId: string, action: 'verify' | 'reject', reason?: string): Promise<boolean> {
    if (!stayId) return false
    setBusy(true)
    try {
      const res = await fetch(`/api/stays/${stayId}/guests/${guestId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const firstField = json.fields ? Object.values(json.fields as Record<string, string>)[0] : null
        toast.error(firstField ?? json.error ?? t('toast.saveFailed'))
        return false
      }
      toast.success(action === 'verify' ? t('toast.idVerified') : t('toast.idRejected'))
      await load()
      onChanged()
      return true
    } catch {
      toast.error(t('toast.saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function resend(body: { messageKey: string } | { guestId: string }, id: string) {
    if (!stayId) return
    setResending(id)
    try {
      const res = await fetch(`/api/stays/${stayId}/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.ok) {
        toast.success(t('toast.resent'))
        await load()
        onChanged()
      } else {
        const why = json.reason ? `: ${String(json.reason).replace(/_/g, ' ')}` : ''
        toast.error(`${t(`resendErrors.${json.error ?? 'not_sent'}`)}${why}`)
      }
    } catch {
      toast.error(t('toast.saveFailed'))
    } finally {
      setResending(null)
    }
  }

  const stay = detail?.stay
  const canCheckout = canIds && !!stay && (stay.status === 'registered' || stay.status === 'checked_in')
  async function markCheckedOut() {
    if (!stayId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/stays/${stayId}/checkout`, { method: 'POST' })
      if (!res.ok) {
        toast.error(t('toast.saveFailed'))
        return
      }
      toast.success(t('toast.checkedOut'))
      setCheckoutOpen(false)
      await load()
      onChanged()
    } catch {
      toast.error(t('toast.saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const canEdit = isAdmin && !!stay && stay.status !== 'cancelled' && stay.status !== 'checked_out'

  async function copyLink() {
    if (!stay?.form_url) return
    try {
      await navigator.clipboard.writeText(stay.form_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('toast.copyFailed'))
    }
  }

  const rulesVersion = (() => {
    const v = detail?.acceptance?.house_rules_versions
    if (!v) return null
    return Array.isArray(v) ? v[0]?.version : v.version
  })()

  return (
    <>
      <Sheet open={!!stayId} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{stay?.stay_ref ?? '…'}</span>
              {stay && <StatusBadge status={stay.status} />}
            </SheetTitle>
            <SheetDescription>{stay?.guest_name ?? t('drawer.loading')}</SheetDescription>
          </SheetHeader>

          <div className="space-y-5 px-4 pb-6">
            {loading && !stay && (
              <div className="flex justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}

            {stay && (
              <>
                {/* Automation */}
                <Section title={t('drawer.automation')}>
                  <div className="flex items-start justify-between gap-3">
                    <AutomationBadge state={stay.automation} />
                    {canEdit && (
                      <label className="flex items-center gap-2 text-sm">
                        <span>{t('drawer.pause')}</span>
                        <Switch
                          checked={stay.automation_paused}
                          disabled={busy}
                          onCheckedChange={(checked) =>
                            patch({ automation_paused: checked }, checked ? t('toast.paused') : t('toast.resumed'))
                          }
                        />
                      </label>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t('drawer.automationHelp')}</p>

                  {!stay.guest_phone && canEdit && (
                    <div className="mt-3 flex gap-2">
                      <Input
                        type="tel"
                        inputMode="tel"
                        value={phoneDraft}
                        onChange={(e) => setPhoneDraft(e.target.value)}
                        placeholder={t('drawer.addMobilePlaceholder')}
                        aria-label={t('form.mobile')}
                      />
                      <Button
                        disabled={busy || !phoneDraft.trim()}
                        onClick={() => patch({ guest_phone: phoneDraft }, t('toast.mobileSaved'))}
                      >
                        {t('drawer.addMobile')}
                      </Button>
                    </div>
                  )}
                </Section>

                {/* Stay details */}
                <Section
                  title={t('drawer.details')}
                  action={
                    canEdit ? (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                        <Pencil className="size-3.5" />
                        {t('drawer.edit')}
                      </Button>
                    ) : null
                  }
                >
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                    <Row label={t('drawer.mobile')} value={stay.guest_phone ? `+${stay.guest_phone}` : '—'} />
                    <Row label={t('drawer.email')} value={stay.guest_email ?? '—'} />
                    <Row label={t('drawer.checkin')} value={formatIst(stay.checkin_at)} />
                    <Row label={t('drawer.checkout')} value={formatIst(stay.checkout_at)} />
                    <Row label={t('drawer.guests')} value={String(stay.guests_count)} />
                    <Row label={t('drawer.source')} value={t(`source.${stay.source}`)} />
                    <Row label={t('drawer.bookingRef')} value={stay.external_booking_ref ?? '—'} />
                    {stay.notes && <Row label={t('drawer.notes')} value={stay.notes} />}
                  </dl>
                </Section>

                {/* Guest form link (admin only: the token is the guest's key) */}
                {isAdmin && stay.form_url && (
                  <Section title={t('drawer.guestForm')} action={<FormBadge status={stay.form_status} />}>
                    <div className="flex gap-2">
                      <Input readOnly value={stay.form_url} onFocus={(e) => e.currentTarget.select()} />
                      <Button variant="outline" size="icon" onClick={copyLink} aria-label={t('created.copyLink')}>
                        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                      </Button>
                      <a
                        href={stay.form_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('drawer.openForm')}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-muted"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </div>
                  </Section>
                )}

                {/* Guests and ID status */}
                <Section title={t('drawer.guestsAndIds')} action={<IdBadge status={stay.id_status} />}>
                  {(stay.stay_guests ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('drawer.noGuestsYet')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {(stay.stay_guests ?? []).map((g) => (
                        <li key={g.id} className="rounded-lg border border-border p-2.5 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-medium">
                              {g.id_verified_at && (
                                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={t('idStatus.verified')} />
                              )}
                              {g.full_name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {g.role === 'lead' ? t('drawer.lead') : g.is_adult ? t('drawer.adult') : t('drawer.child')}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {g.id_type && <span>{g.id_type.replace('_', ' ')}{g.id_last4 ? ` ····${g.id_last4}` : ''}</span>}
                            {g.form_c_required && <span className="text-amber-600 dark:text-amber-300">{t('drawer.formC')}</span>}
                            <span>
                              {g.id_verified_at
                                ? t('idStatus.verified')
                                : g.id_rejected_at
                                  ? t('idStatus.rejected')
                                  : g.is_adult
                                    ? t('idStatus.pending')
                                    : ''}
                            </span>
                          </div>
                          {canIds && (() => {
                            const docs = (detail?.documents ?? []).filter((d) => d.guest_id === g.id)
                            if (docs.length === 0 && !g.is_adult) return null
                            const canUpload = stay.status !== 'cancelled'
                            return (
                              <div className="mt-2 space-y-2">
                                <div className="flex flex-wrap gap-2">
                                  {docs.map((d) => (
                                    <Button
                                      key={d.id}
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={openingDoc === d.id}
                                      onClick={() =>
                                        void openDocument(d.id, `${g.full_name} · ${d.side === 'back' ? t('drawer.idBack') : t('drawer.idFront')}`)
                                      }
                                    >
                                      {openingDoc === d.id ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
                                      {d.side === 'back' ? t('drawer.viewBack') : t('drawer.viewFront')}
                                    </Button>
                                  ))}
                                  {docs.length === 0 && g.is_adult && (
                                    <span className="text-xs text-muted-foreground">{t('drawer.noIdFile')}</span>
                                  )}
                                </div>
                                {canIds && g.is_adult && docs.some((d) => d.side === 'front') && (
                                  rejectFor === g.id ? (
                                    <div className="space-y-2">
                                      <Input
                                        value={rejectReason}
                                        onChange={(e) => setRejectReason(e.target.value)}
                                        placeholder={t('drawer.rejectReasonPlaceholder')}
                                        maxLength={300}
                                      />
                                      <div className="flex gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="destructive"
                                          disabled={busy || rejectReason.trim().length < 3}
                                          onClick={async () => {
                                            if (await review(g.id, 'reject', rejectReason)) {
                                              setRejectFor(null)
                                              setRejectReason('')
                                            }
                                          }}
                                        >
                                          {t('drawer.confirmReject')}
                                        </Button>
                                        <Button type="button" size="sm" variant="ghost" onClick={() => setRejectFor(null)}>
                                          {t('drawer.cancelReject')}
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex gap-2">
                                      {!g.id_verified_at && (
                                        <Button type="button" size="sm" disabled={busy} onClick={() => void review(g.id, 'verify')}>
                                          <Check className="size-3.5" />
                                          {t('drawer.verify')}
                                        </Button>
                                      )}
                                      {!g.id_rejected_at && (
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          disabled={busy}
                                          onClick={() => {
                                            setRejectFor(g.id)
                                            setRejectReason('')
                                          }}
                                        >
                                          <X className="size-3.5" />
                                          {t('drawer.reject')}
                                        </Button>
                                      )}
                                    </div>
                                  )
                                )}
                                {g.id_rejected_at && stay.guest_phone && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={resending === `id:${g.id}`}
                                    onClick={() => void resend({ guestId: g.id }, `id:${g.id}`)}
                                  >
                                    {resending === `id:${g.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                                    {t('drawer.resendRejected')}
                                  </Button>
                                )}
                                {canUpload && (
                                  <StaffIdUpload
                                    stayId={stay.id}
                                    guestId={g.id}
                                    hasFront={docs.some((d) => d.side === 'front')}
                                    hasBack={docs.some((d) => d.side === 'back')}
                                    onUploaded={() => {
                                      void load()
                                      onChanged()
                                    }}
                                  />
                                )}
                              </div>
                            )
                          })()}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canIds && detail && detail.documents.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('drawer.idFiles', { count: detail.documents.length })}
                    </p>
                  )}
                </Section>

                {/* Scheduled WhatsApp messages */}
                <Section title={t('drawer.messages')}>
                  {(detail?.messages ?? []).length === 0 ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">{t('drawer.messagesNone')}</p>
                      {canIds && stay?.guest_phone && stay.status !== 'cancelled' && stay.status !== 'checked_out' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={resending === 'form_link'}
                          onClick={() => void resend({ messageKey: 'form_link' }, 'form_link')}
                        >
                          {resending === 'form_link' ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                          {t('drawer.sendFormLinkNow')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <ul className="space-y-1.5 text-sm">
                      {(detail?.messages ?? []).map((m) => (
                        <li key={m.message_key} className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate">{t(`messageKeys.${m.message_key}`)}</p>
                            <p className="text-xs text-muted-foreground">
                              {m.sent_at ? formatIst(m.sent_at) : formatIst(m.due_at)}
                              {m.last_error && m.status !== 'sent' ? ` · ${m.last_error.replace(/_/g, ' ')}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-muted-foreground">{t(`messageStatus.${m.status}`)}</span>
                            {canIds && !['id_alert_staff', 'owner_alert'].includes(m.message_key) && m.status !== 'sending' && m.status !== 'cancelled' && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={resending === m.message_key}
                                onClick={() => void resend({ messageKey: m.message_key }, m.message_key)}
                              >
                                {resending === m.message_key ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                                {m.status === 'sent' ? t('drawer.resend') : t('drawer.sendNow')}
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                {/* House rules acceptance */}
                <Section title={t('drawer.houseRules')}>
                  {detail?.acceptance ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                      <Row label={t('drawer.signedBy')} value={detail.acceptance.typed_name} />
                      <Row label={t('drawer.signedAt')} value={formatIst(detail.acceptance.accepted_at)} />
                      {rulesVersion != null && <Row label={t('drawer.rulesVersion')} value={`v${rulesVersion}`} />}
                      {isAdmin && detail.acceptance.ip_address && (
                        <Row label={t('drawer.ip')} value={detail.acceptance.ip_address} />
                      )}
                    </dl>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('drawer.notAccepted')}</p>
                  )}
                </Section>

                {/* What happened at each ID review, newest first (kept permanently) */}
                {canIds && (
                  <Section title={t('drawer.reviewHistory')}>
                    {(detail?.reviews ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('drawer.reviewHistoryNone')}</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {(detail?.reviews ?? []).map((r) => {
                          const who = (stay.stay_guests ?? []).find((g) => g.id === r.guest_id)?.full_name ?? ''
                          return (
                            <li key={r.id} className="rounded-lg border border-border p-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5 font-medium">
                                  {r.action === 'approved' ? (
                                    <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                                  ) : (
                                    <X className="size-4 text-red-600 dark:text-red-400" />
                                  )}
                                  {r.action === 'approved' ? t('drawer.reviewApproved') : t('drawer.reviewRejected')}
                                  {who ? ` · ${who}` : ''}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">{formatIst(r.created_at)}</span>
                              </div>
                              {r.reason && <p className="mt-1">{t('drawer.reviewReason', { reason: r.reason })}</p>}
                              {r.reviewer_name && (
                                <p className="mt-0.5 text-xs text-muted-foreground">{t('drawer.reviewBy', { name: r.reviewer_name })}</p>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </Section>
                )}

                {isAdmin && stay.status !== 'cancelled' && stay.status !== 'sample' && (
                  <DepositCard key={`${stay.id}:${stay.status}`} stayId={stay.id} onChanged={onChanged} />
                )}

                {canCheckout && (
                  <div className="border-t border-border pt-4">
                    <Button variant="outline" onClick={() => setCheckoutOpen(true)} disabled={busy}>
                      {t('drawer.markCheckedOut')}
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">{t('drawer.checkedOutHelp')}</p>
                  </div>
                )}

                {canEdit && (
                  <div className="border-t border-border pt-4">
                    <Button variant="destructive" onClick={() => setCancelOpen(true)}>
                      {t('drawer.cancelStay')}
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">{t('drawer.cancelHelp')}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {editing && stay && (
        <StayFormDialog
          key={`edit-${stay.id}-${stay.updated_at}`}
          open
          onOpenChange={(o) => !o && setEditing(false)}
          stay={stay}
          onSaved={(s: SavedStay) => {
            void s
            setEditing(false)
            void load()
            onChanged()
          }}
        />
      )}

      <Dialog open={!!viewer} onOpenChange={(o) => !o && setViewer(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{viewer?.label}</DialogTitle>
            <DialogDescription>{t('drawer.viewerNote')}</DialogDescription>
          </DialogHeader>
          {viewer &&
            (viewer.contentType === 'application/pdf' ? (
              <a
                href={viewer.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-2 text-sm font-medium text-primary underline"
              >
                <ExternalLink className="size-4" />
                {t('drawer.openPdf')}
              </a>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
              <img src={viewer.url} alt={viewer.label} className="max-h-[70vh] w-full rounded-md object-contain" />
            ))}
        </DialogContent>
      </Dialog>

      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('drawer.markCheckedOut')}</DialogTitle>
            <DialogDescription>{t('drawer.checkedOutHelp')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckoutOpen(false)}>{t('cancel.keep')}</Button>
            <Button onClick={markCheckedOut} disabled={busy}>{t('drawer.markCheckedOut')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('cancel.title')}</DialogTitle>
            <DialogDescription>{t('cancel.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => setCancelOpen(false)} className="w-full sm:w-auto">
              {t('cancel.keep')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              className="w-full sm:w-auto"
              onClick={async () => {
                const ok = await patch({ status: 'cancelled' }, t('toast.cancelled'))
                if (ok) setCancelOpen(false)
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('cancel.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  )
}
