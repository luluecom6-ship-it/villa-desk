'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Copy, Loader2, MessageCircle } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { STAY_SOURCES, type StaySource } from '@/lib/stays/types'
import { toIstInputValue } from '@/lib/stays/time'
import { buildFormMessage, whatsAppLink } from '@/lib/stays/share'

// One dialog for "New registration" (PDR 5.2) and "Edit details" (PDR 5.3).
// After a successful create it switches to a confirmation that shows the Stay
// Reference and the guest-form link with "Copy link" / "Send form on WhatsApp".

const COUNTRY_CODES: Array<{ code: string; label: string }> = [
  { code: '91', label: 'IN +91' },
  { code: '971', label: 'AE +971' },
  { code: '966', label: 'SA +966' },
  { code: '1', label: 'US/CA +1' },
  { code: '44', label: 'GB +44' },
  { code: '65', label: 'SG +65' },
  { code: '61', label: 'AU +61' },
]

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30'

export interface SavedStay {
  id: string
  stay_ref: string
  guest_name: string
  guest_phone: string | null
  form_url?: string
  automation: { on: boolean }
}

export interface EditableStay {
  id: string
  guest_name: string
  guest_phone: string | null
  guest_email: string | null
  source: StaySource
  external_booking_ref: string | null
  checkin_at: string
  checkout_at: string
  guests_count: number
  notes: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set the dialog edits this stay; otherwise it creates one. */
  stay?: EditableStay | null
  onSaved: (stay: SavedStay) => void
}

function defaultTimes() {
  // Today 14:00 check-in, tomorrow 11:00 check-out, in the villa's local time.
  const now = new Date()
  const today = toIstInputValue(now).slice(0, 10)
  const tomorrow = toIstInputValue(new Date(now.getTime() + 24 * 60 * 60 * 1000)).slice(0, 10)
  return { checkin: `${today}T14:00`, checkout: `${tomorrow}T11:00` }
}

export function StayFormDialog({ open, onOpenChange, stay, onSaved }: Props) {
  const t = useTranslations('Stays')
  const isEdit = !!stay
  const defaults = useMemo(defaultTimes, [])

  const [name, setName] = useState(stay?.guest_name ?? '')
  const [countryCode, setCountryCode] = useState('91')
  const [phone, setPhone] = useState(stay?.guest_phone ? `+${stay.guest_phone}` : '')
  const [email, setEmail] = useState(stay?.guest_email ?? '')
  const [checkin, setCheckin] = useState(stay ? toIstInputValue(stay.checkin_at) : defaults.checkin)
  const [checkout, setCheckout] = useState(stay ? toIstInputValue(stay.checkout_at) : defaults.checkout)
  const [guests, setGuests] = useState(String(stay?.guests_count ?? 2))
  const [source, setSource] = useState<StaySource>(stay?.source ?? 'direct')
  const [bookingRef, setBookingRef] = useState(stay?.external_booking_ref ?? '')
  const [notes, setNotes] = useState(stay?.notes ?? '')

  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<SavedStay | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  const touch = (field: string) => setTouched((p) => ({ ...p, [field]: true }))

  // Required-field errors show only after the field was touched or a submit
  // was attempted (the early red-border bug called out in the PDR).
  const clientErrors: Record<string, string> = {}
  if (!name.trim()) clientErrors.guest_name = t('errors.nameRequired')
  if (!checkin) clientErrors.checkin_at = t('errors.checkinInvalid')
  if (!checkout) clientErrors.checkout_at = t('errors.checkoutInvalid')
  else if (checkin && checkout <= checkin) clientErrors.checkout_at = t('errors.checkoutBeforeCheckin')

  const errorFor = (field: string) =>
    serverErrors[field] ?? (touched[field] ? clientErrors[field] : undefined)

  const noMobile = phone.trim() === ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setTouched({ guest_name: true, checkin_at: true, checkout_at: true })
    if (Object.keys(clientErrors).length > 0) return

    setSaving(true)
    setServerErrors({})
    try {
      const payload: Record<string, unknown> = {
        guest_name: name,
        guest_phone: phone,
        country_code: countryCode,
        guest_email: email,
        checkin_at: checkin,
        checkout_at: checkout,
        guests_count: Number(guests) || 1,
        source,
        external_booking_ref: bookingRef,
        notes,
      }
      const res = await fetch(isEdit ? `/api/stays/${stay!.id}` : '/api/stays', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (json.fields) setServerErrors(json.fields)
        toast.error(json.error ?? t('toast.saveFailed'))
        return
      }
      const result = json.stay as SavedStay
      onSaved(result)
      if (isEdit) {
        toast.success(t('toast.updated'))
        onOpenChange(false)
      } else {
        setSaved(result)
        setWarnings(json.warnings ?? [])
      }
    } catch {
      toast.error(t('toast.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function copyLink() {
    if (!saved?.form_url) return
    try {
      await navigator.clipboard.writeText(saved.form_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('toast.copyFailed'))
    }
  }

  // Success state after creating.
  if (saved) {
    const wa = saved.guest_phone && saved.form_url
      ? whatsAppLink(saved.guest_phone, buildFormMessage({ name: saved.guest_name, ref: saved.stay_ref, url: saved.form_url }))
      : null
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('created.title')}</DialogTitle>
            <DialogDescription>{t('created.description', { name: saved.guest_name })}</DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{t('created.reference')}</p>
            <p className="font-mono text-lg font-semibold">{saved.stay_ref}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('created.formLink')}</Label>
            <Input readOnly value={saved.form_url ?? ''} onFocus={(e) => e.currentTarget.select()} />
          </div>

          <p className="text-sm text-muted-foreground">
            {saved.automation.on ? t('created.automationOn') : t('created.automationOff')}
          </p>
          {warnings.map((w) => (
            <p key={w} className="text-sm text-amber-600 dark:text-amber-300">{w}</p>
          ))}

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={copyLink} className="w-full sm:w-auto">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t('created.copied') : t('created.copyLink')}
            </Button>
            {wa ? (
              <a
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants(), 'w-full sm:w-auto')}
              >
                <MessageCircle className="size-4" />
                {t('created.sendWhatsApp')}
              </a>
            ) : (
              <Button className="w-full sm:w-auto" disabled title={t('created.needsMobile')}>
                <MessageCircle className="size-4" />
                {t('created.sendWhatsApp')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('form.editTitle') : t('form.newTitle')}</DialogTitle>
          <DialogDescription>
            {isEdit ? t('form.editDescription') : t('form.newDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label={t('form.guestName')} error={errorFor('guest_name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => touch('guest_name')}
              aria-invalid={!!errorFor('guest_name')}
              autoComplete="off"
              maxLength={120}
            />
          </Field>

          <Field label={t('form.mobile')} error={errorFor('guest_phone')} hint={noMobile ? t('form.mobileDraftHint') : t('form.mobileHint')}>
            <div className="flex gap-2">
              <select
                className={`${SELECT_CLASS} w-28 shrink-0`}
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                aria-label={t('form.countryCode')}
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
              <Input
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                aria-invalid={!!errorFor('guest_phone')}
              />
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.checkin')} error={errorFor('checkin_at')}>
              <Input
                type="datetime-local"
                value={checkin}
                onChange={(e) => setCheckin(e.target.value)}
                onBlur={() => touch('checkin_at')}
                aria-invalid={!!errorFor('checkin_at')}
              />
            </Field>
            <Field label={t('form.checkout')} error={errorFor('checkout_at')}>
              <Input
                type="datetime-local"
                value={checkout}
                onChange={(e) => setCheckout(e.target.value)}
                onBlur={() => touch('checkout_at')}
                aria-invalid={!!errorFor('checkout_at')}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.guests')} error={errorFor('guests_count')}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
              />
            </Field>
            <Field label={t('form.source')} error={errorFor('source')}>
              <select
                className={SELECT_CLASS}
                value={source}
                onChange={(e) => setSource(e.target.value as StaySource)}
              >
                {STAY_SOURCES.map((s) => (
                  <option key={s} value={s}>{t(`source.${s}`)}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('form.bookingRef')} error={errorFor('external_booking_ref')} hint={t('form.bookingRefHint')}>
            <Input
              value={bookingRef}
              onChange={(e) => setBookingRef(e.target.value)}
              placeholder="HMABCD1234"
              maxLength={100}
              autoComplete="off"
            />
          </Field>

          <Field label={t('form.email')} error={errorFor('guest_email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </Field>

          <Field label={t('form.notes')} error={errorFor('notes')}>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} />
          </Field>

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              {t('form.cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('form.save') : t('form.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
