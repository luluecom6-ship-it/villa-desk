'use client'

import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatIst } from '@/lib/stays/time'
import { MAX_REQUEST_BYTES } from '@/lib/stays/files'
import {
  ID_TYPES,
  MAX_OCCUPANTS,
  PURPOSES,
  isAdultAge,
  parseGuestForm,
  type GuestFormInput,
  type GuestFormLead,
  type GuestFormOccupant,
} from '@/lib/stays/guest-form'
import { IdCapture, type IdSlot } from './id-capture'

// Public guest registration form (PDR 6). Phone first: single column, large
// touch targets, nothing marked invalid until a field is touched or Submit is
// pressed. Works for first-time submits and for reopening until check-in.

interface PublicFormData {
  stay: {
    stay_ref: string
    guest_name: string
    property_name: string | null
    checkin_at: string
    checkout_at: string
    guests_count: number
    mobile_masked: string | null
  }
  rules: { id: string; version: number; title: string; body: string } | null
  submitted: boolean
  read_only: boolean
  signed: boolean
  existing: {
    lead: Omit<GuestFormLead, 'mobile'> | null
    occupants: Array<GuestFormOccupant & { age: string | number }>
    arrival: GuestFormInput['arrival']
    files: Record<string, { front: boolean; back: boolean }>
  }
}

type View = 'loading' | 'invalid' | 'error' | 'form' | 'done' | 'closed'

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'
const INPUT_CLASS = 'h-11 text-base'

const EMPTY_LEAD: GuestFormLead = {
  full_name: '',
  mobile: '',
  email: '',
  is_foreign: false,
  nationality: '',
  address: '',
  id_type: '',
  id_last4: '',
  visa_type: '',
  visa_expiry: '',
  arrived_in_india_on: '',
}
const EMPTY_ARRIVAL: GuestFormInput['arrival'] = {
  expected_arrival_time: '',
  vehicle_number: '',
  special_request: '',
  purpose_of_visit: '',
}

export function GuestForm({ token }: { token: string }) {
  const t = useTranslations('GuestForm')
  const [view, setView] = useState<View>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [data, setData] = useState<PublicFormData | null>(null)

  const [lead, setLead] = useState<GuestFormLead>(EMPTY_LEAD)
  const [arrival, setArrival] = useState(EMPTY_ARRIVAL)
  const [occupants, setOccupants] = useState<GuestFormOccupant[]>([])
  const [slots, setSlots] = useState<Record<string, IdSlot | null>>({})
  const [accepted, setAccepted] = useState(false)
  const [typedName, setTypedName] = useState('')

  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [doneRef, setDoneRef] = useState<string | null>(null)
  const nextKey = useRef(1)

  const load = useCallback(async () => {
    setView('loading')
    try {
      const res = await fetch(`/api/public/stay/${encodeURIComponent(token)}`, { cache: 'no-store' })
      if (res.status === 404) return setView('invalid')
      if (res.status === 429) {
        setMessage(t('errors.tooMany'))
        return setView('error')
      }
      if (!res.ok) {
        setMessage(t('errors.loadFailed'))
        return setView('error')
      }
      const json = (await res.json()) as PublicFormData
      setData(json)
      const ex = json.existing
      setLead({ ...EMPTY_LEAD, ...(ex.lead ?? {}), mobile: '', full_name: ex.lead?.full_name ?? json.stay.guest_name })
      setArrival({ ...EMPTY_ARRIVAL, ...ex.arrival })
      setOccupants(
        ex.occupants.map((o) => ({
          client_key: o.client_key,
          id: o.id,
          full_name: o.full_name,
          age: String(o.age ?? ''),
          id_type: o.id_type,
          id_last4: o.id_last4,
        })),
      )
      setSlots({})
      setTouched({})
      setAttempted(false)
      setServerErrors({})
      setSubmitError(null)
      if (json.read_only) setView('closed')
      else if (!json.rules) {
        setMessage(t('errors.notOpenYet'))
        setView('error')
      } else setView('form')
    } catch {
      setMessage(t('errors.loadFailed'))
      setView('error')
    }
  }, [token, t])

  useEffect(() => {
    void load()
  }, [load])

  // ---- Derived validation -------------------------------------------------
  const adultKeys = useMemo(() => {
    const keys = ['lead']
    for (const o of occupants) {
      const age = Number(o.age)
      if (String(o.age).trim() !== '' && Number.isInteger(age) && isAdultAge(age)) keys.push(o.client_key)
    }
    return keys
  }, [occupants])

  const buildInput = useCallback((): GuestFormInput => {
    const documents: GuestFormInput['documents'] = []
    for (const key of adultKeys) {
      for (const side of ['front', 'back'] as const) {
        if (slots[`${key}:${side}`]) documents.push({ guest_key: key, side })
      }
    }
    return {
      lead,
      arrival,
      occupants,
      documents,
      acceptance: { accepted, typed_name: typedName, rules_version_id: data?.rules?.id ?? '' },
    }
  }, [adultKeys, slots, lead, arrival, occupants, accepted, typedName, data])

  const existingFronts = useMemo(
    () => Object.entries(data?.existing.files ?? {}).filter(([, f]) => f.front).map(([k]) => k),
    [data],
  )

  const validation = useMemo(
    () => parseGuestForm(buildInput(), { alreadySigned: !!data?.signed, existingFronts }),
    [buildInput, data, existingFronts],
  )
  const clientErrors = validation.ok ? {} : validation.errors

  const show = (path: string) => attempted || touched[path]
  const err = (path: string): string | undefined => {
    if (serverErrors[path]) return serverErrors[path]
    const key = clientErrors[path]
    return key && show(path) ? t(`errors.${key}`) : undefined
  }
  const touch = (path: string) => setTouched((p) => (p[path] ? p : { ...p, [path]: true }))

  // ---- Updaters -----------------------------------------------------------
  const setLeadField = <K extends keyof GuestFormLead>(k: K, v: GuestFormLead[K]) =>
    setLead((p) => ({ ...p, [k]: v }))
  const setOccupant = (index: number, patch: Partial<GuestFormOccupant>) =>
    setOccupants((p) => p.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  const setSlot = (key: string, side: 'front' | 'back', slot: IdSlot | null) =>
    setSlots((p) => ({ ...p, [`${key}:${side}`]: slot }))

  function addOccupant() {
    if (occupants.length >= MAX_OCCUPANTS) return
    const client_key = `n${nextKey.current++}`
    setOccupants((p) => [...p, { client_key, full_name: '', age: '', id_type: '', id_last4: '' }])
  }
  function removeOccupant(index: number) {
    const o = occupants[index]
    if (o.id) return // saved people cannot be removed from the form
    setOccupants((p) => p.filter((_, i) => i !== index))
    setSlots((p) => {
      const next = { ...p }
      delete next[`${o.client_key}:front`]
      delete next[`${o.client_key}:back`]
      return next
    })
  }

  // ---- Submit -------------------------------------------------------------
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setAttempted(true)
    setServerErrors({})
    setSubmitError(null)
    if (!validation.ok) {
      requestAnimationFrame(() =>
        document.querySelector('[data-field-error]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      )
      return
    }

    const input = buildInput()
    const body = new FormData()
    body.set('data', JSON.stringify(input))
    let total = 0
    for (const d of input.documents) {
      const slot = slots[`${d.guest_key}:${d.side}`]
      if (!slot) continue
      total += slot.file.size
      body.set(`file:${d.guest_key}:${d.side}`, slot.file, slot.file.name)
    }
    if (total > MAX_REQUEST_BYTES) {
      setSubmitError(t('errors.requestTooLarge'))
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/public/stay/${encodeURIComponent(token)}`, { method: 'POST', body })
      const json = await res.json().catch(() => ({}))
      if (res.ok) {
        setDoneRef(json.stay_ref ?? data?.stay.stay_ref ?? null)
        setView('done')
        window.scrollTo({ top: 0 })
        return
      }
      if (res.status === 404) return setView('invalid')
      if (json.fields) setServerErrors(json.fields)
      setSubmitError(json.error ?? t('errors.saveFailed'))
      if (res.status === 409) void 0 // closed / rules changed: message explains; reload below if closed
      requestAnimationFrame(() =>
        document.querySelector('[data-field-error]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      )
    } catch {
      setSubmitError(t('errors.network'))
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Small view helpers -------------------------------------------------
  const FieldError = ({ path }: { path: string }) => {
    const m = err(path)
    return m ? (
      <p data-field-error className="mt-1 text-xs text-destructive">
        {m}
      </p>
    ) : null
  }

  const idTypeLabel = (v: string) => t(`idTypes.${v}`)

  // ---- Non-form views -----------------------------------------------------
  if (view === 'loading') {
    return (
      <Shell>
        <div className="flex justify-center py-24">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    )
  }

  if (view === 'invalid') {
    return (
      <Shell>
        <Notice title={t('invalid.title')} body={t('invalid.body')} />
      </Shell>
    )
  }

  if (view === 'error') {
    return (
      <Shell>
        <Notice title={t('error.title')} body={message ?? t('errors.loadFailed')} />
        <Button className="mt-4 h-11 w-full" variant="outline" onClick={() => void load()}>
          {t('error.retry')}
        </Button>
      </Shell>
    )
  }

  if (view === 'closed' && data) {
    return (
      <Shell>
        <Notice
          icon
          title={t('closed.title')}
          body={t('closed.body')}
          reference={data.stay.stay_ref}
          refLabel={t('done.reference')}
        />
      </Shell>
    )
  }

  if (view === 'done') {
    return (
      <Shell>
        <Notice
          icon
          title={t('done.title', { name: lead.full_name.split(' ')[0] || '' })}
          body={t('done.body')}
          reference={doneRef ?? data?.stay.stay_ref ?? ''}
          refLabel={t('done.reference')}
        />
        <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-medium">{t('done.readyTitle')}</p>
          <p className="mt-1 text-muted-foreground">{t('done.readyBody')}</p>
        </div>
        <Button className="mt-4 h-11 w-full" variant="outline" onClick={() => void load()}>
          {t('done.edit')}
        </Button>
        <p className="mt-2 text-center text-xs text-muted-foreground">{t('done.editHint')}</p>
      </Shell>
    )
  }

  if (!data) return null

  const leadIdError = err('lead.id_type')
  const frontError = (key: string) => err(`documents.${key}`) ?? serverErrors[`files.${key}.front`]
  const backError = (key: string) => serverErrors[`files.${key}.back`]

  // ---- The form -----------------------------------------------------------
  return (
    <Shell>
      <header className="mb-5">
        {data.stay.property_name && (
          <p className="text-sm font-medium text-muted-foreground">{data.stay.property_name}</p>
        )}
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <div className="mt-3 rounded-xl border border-border bg-card p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('done.reference')}</span>
            <span className="font-mono font-semibold">{data.stay.stay_ref}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('stay.dates')}</span>
            <span className="text-right">
              {formatIst(data.stay.checkin_at)} → {formatIst(data.stay.checkout_at)}
            </span>
          </div>
        </div>
        {data.submitted && (
          <p className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
            {t('alreadySubmitted')}
          </p>
        )}
      </header>

      <form onSubmit={submit} noValidate className="space-y-5">
        {/* Why we ask for ID (PDR 13.2) */}
        <div className="flex gap-3 rounded-xl border border-border bg-muted/40 p-3 text-sm">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="text-muted-foreground">{t('privacy')}</p>
        </div>

        {/* Lead guest */}
        <Section title={t('lead.title')}>
          <Field label={t('lead.fullName')} required>
            <Input
              className={INPUT_CLASS}
              value={lead.full_name}
              onChange={(e) => setLeadField('full_name', e.target.value)}
              onBlur={() => touch('lead.full_name')}
              aria-invalid={!!err('lead.full_name')}
              autoComplete="name"
              maxLength={120}
            />
            <FieldError path="lead.full_name" />
          </Field>

          <Field label={t('lead.mobile')} hint={data.stay.mobile_masked ? t('lead.mobileLocked') : undefined}>
            {data.stay.mobile_masked ? (
              <Input className={INPUT_CLASS} value={data.stay.mobile_masked} readOnly disabled />
            ) : (
              <Input
                className={INPUT_CLASS}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={lead.mobile}
                onChange={(e) => setLeadField('mobile', e.target.value)}
              />
            )}
          </Field>

          <Field label={t('lead.email')}>
            <Input
              className={INPUT_CLASS}
              type="email"
              autoComplete="email"
              value={lead.email}
              onChange={(e) => setLeadField('email', e.target.value)}
              onBlur={() => touch('lead.email')}
              aria-invalid={!!err('lead.email')}
            />
            <FieldError path="lead.email" />
          </Field>

          <Field label={t('lead.nationalityType')}>
            <select
              className={SELECT_CLASS}
              value={lead.is_foreign ? 'foreign' : 'indian'}
              onChange={(e) => {
                const foreign = e.target.value === 'foreign'
                setLead((p) => ({ ...p, is_foreign: foreign, id_type: foreign ? 'passport' : p.id_type === 'passport' ? '' : p.id_type }))
              }}
            >
              <option value="indian">{t('lead.indian')}</option>
              <option value="foreign">{t('lead.foreign')}</option>
            </select>
          </Field>

          {lead.is_foreign && (
            <>
              <Field label={t('lead.nationality')} required>
                <Input
                  className={INPUT_CLASS}
                  value={lead.nationality}
                  onChange={(e) => setLeadField('nationality', e.target.value)}
                  onBlur={() => touch('lead.nationality')}
                  aria-invalid={!!err('lead.nationality')}
                  maxLength={60}
                />
                <FieldError path="lead.nationality" />
              </Field>
              <p className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">{t('lead.formCNote')}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('lead.visaType')}>
                  <Input className={INPUT_CLASS} value={lead.visa_type} onChange={(e) => setLeadField('visa_type', e.target.value)} maxLength={60} />
                </Field>
                <Field label={t('lead.visaExpiry')}>
                  <Input className={INPUT_CLASS} type="date" value={lead.visa_expiry} onChange={(e) => setLeadField('visa_expiry', e.target.value)} />
                  <FieldError path="lead.visa_expiry" />
                </Field>
              </div>
              <Field label={t('lead.arrivedInIndia')}>
                <Input className={INPUT_CLASS} type="date" value={lead.arrived_in_india_on} onChange={(e) => setLeadField('arrived_in_india_on', e.target.value)} />
                <FieldError path="lead.arrived_in_india_on" />
              </Field>
            </>
          )}

          <Field label={t('lead.address')} required>
            <Textarea
              className="text-base"
              rows={2}
              value={lead.address}
              onChange={(e) => setLeadField('address', e.target.value)}
              onBlur={() => touch('lead.address')}
              aria-invalid={!!err('lead.address')}
              autoComplete="street-address"
              maxLength={300}
            />
            <FieldError path="lead.address" />
          </Field>

          <Field label={t('arrival.purpose')}>
            <select
              className={SELECT_CLASS}
              value={arrival.purpose_of_visit}
              onChange={(e) => setArrival((p) => ({ ...p, purpose_of_visit: e.target.value }))}
            >
              <option value="">{t('arrival.purposeChoose')}</option>
              {PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {t(`purposes.${p}`)}
                </option>
              ))}
            </select>
          </Field>
        </Section>

        {/* Arrival */}
        <Section title={t('arrival.title')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('arrival.time')}>
              <Input
                className={INPUT_CLASS}
                type="time"
                value={arrival.expected_arrival_time}
                onChange={(e) => setArrival((p) => ({ ...p, expected_arrival_time: e.target.value }))}
                onBlur={() => touch('arrival.expected_arrival_time')}
              />
              <FieldError path="arrival.expected_arrival_time" />
            </Field>
            <Field label={t('arrival.vehicle')}>
              <Input
                className={INPUT_CLASS}
                value={arrival.vehicle_number}
                onChange={(e) => setArrival((p) => ({ ...p, vehicle_number: e.target.value.toUpperCase() }))}
                autoCapitalize="characters"
                maxLength={20}
                placeholder="KA01AB1234"
              />
              <FieldError path="arrival.vehicle_number" />
            </Field>
          </div>
          <Field label={t('arrival.request')} hint={t('arrival.requestHint')}>
            <Textarea
              className="text-base"
              rows={2}
              value={arrival.special_request}
              onChange={(e) => setArrival((p) => ({ ...p, special_request: e.target.value }))}
              maxLength={500}
            />
            <FieldError path="arrival.special_request" />
          </Field>
        </Section>

        {/* Lead ID */}
        <Section title={t('id.titleLead')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('id.type')} required>
              <select
                className={SELECT_CLASS}
                value={lead.id_type}
                disabled={lead.is_foreign}
                onChange={(e) => setLeadField('id_type', e.target.value)}
                onBlur={() => touch('lead.id_type')}
                aria-invalid={!!leadIdError}
              >
                <option value="">{t('id.choose')}</option>
                {ID_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {idTypeLabel(v)}
                  </option>
                ))}
              </select>
              <FieldError path="lead.id_type" />
            </Field>
            <Field label={t('id.last4')} required hint={t('id.last4Hint')}>
              <Input
                className={cn(INPUT_CLASS, 'tracking-widest')}
                value={lead.id_last4}
                onChange={(e) => setLeadField('id_last4', e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 4))}
                onBlur={() => touch('lead.id_last4')}
                aria-invalid={!!err('lead.id_last4')}
                maxLength={4}
                autoComplete="off"
              />
              <FieldError path="lead.id_last4" />
            </Field>
          </div>
          <IdCapture
            label={t('id.front')}
            required
            value={slots['lead:front'] ?? null}
            onChange={(s) => setSlot('lead', 'front', s)}
            alreadyUploaded={data.existing.files.lead?.front}
            error={frontError('lead')}
          />
          <IdCapture
            label={t('id.back')}
            value={slots['lead:back'] ?? null}
            onChange={(s) => setSlot('lead', 'back', s)}
            alreadyUploaded={data.existing.files.lead?.back}
            error={backError('lead')}
          />
        </Section>

        {/* Other guests */}
        <Section title={t('occupants.title')}>
          <p className="text-sm text-muted-foreground">
            {t('occupants.hint', { count: data.stay.guests_count })}
          </p>

          {occupants.map((o, i) => {
            const age = Number(o.age)
            const isAdult = String(o.age).trim() !== '' && Number.isInteger(age) && isAdultAge(age)
            const p = `occupants.${i}`
            return (
              <div key={o.client_key} className="space-y-4 rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{t('occupants.guestN', { n: i + 2 })}</span>
                  {!o.id && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeOccupant(i)}>
                      <Trash2 className="size-4" />
                      {t('occupants.remove')}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-[1fr_6rem] gap-3">
                  <Field label={t('occupants.name')} required>
                    <Input
                      className={INPUT_CLASS}
                      value={o.full_name}
                      onChange={(e) => setOccupant(i, { full_name: e.target.value })}
                      onBlur={() => touch(`${p}.full_name`)}
                      aria-invalid={!!err(`${p}.full_name`)}
                      maxLength={120}
                    />
                    <FieldError path={`${p}.full_name`} />
                  </Field>
                  <Field label={t('occupants.age')} required>
                    <Input
                      className={INPUT_CLASS}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={120}
                      value={String(o.age)}
                      onChange={(e) => setOccupant(i, { age: e.target.value })}
                      onBlur={() => touch(`${p}.age`)}
                      aria-invalid={!!err(`${p}.age`)}
                    />
                    <FieldError path={`${p}.age`} />
                  </Field>
                </div>

                {isAdult ? (
                  <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label={t('id.type')} required>
                        <select
                          className={SELECT_CLASS}
                          value={o.id_type}
                          onChange={(e) => setOccupant(i, { id_type: e.target.value })}
                          onBlur={() => touch(`${p}.id_type`)}
                          aria-invalid={!!err(`${p}.id_type`)}
                        >
                          <option value="">{t('id.choose')}</option>
                          {ID_TYPES.map((v) => (
                            <option key={v} value={v}>
                              {idTypeLabel(v)}
                            </option>
                          ))}
                        </select>
                        <FieldError path={`${p}.id_type`} />
                      </Field>
                      <Field label={t('id.last4')} required hint={t('id.last4Hint')}>
                        <Input
                          className={cn(INPUT_CLASS, 'tracking-widest')}
                          value={o.id_last4}
                          onChange={(e) => setOccupant(i, { id_last4: e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 4) })}
                          onBlur={() => touch(`${p}.id_last4`)}
                          aria-invalid={!!err(`${p}.id_last4`)}
                          maxLength={4}
                          autoComplete="off"
                        />
                        <FieldError path={`${p}.id_last4`} />
                      </Field>
                    </div>
                    <IdCapture
                      label={t('id.front')}
                      required
                      value={slots[`${o.client_key}:front`] ?? null}
                      onChange={(s) => setSlot(o.client_key, 'front', s)}
                      alreadyUploaded={data.existing.files[o.client_key]?.front}
                      error={frontError(o.client_key)}
                    />
                    <IdCapture
                      label={t('id.back')}
                      value={slots[`${o.client_key}:back`] ?? null}
                      onChange={(s) => setSlot(o.client_key, 'back', s)}
                      alreadyUploaded={data.existing.files[o.client_key]?.back}
                      error={backError(o.client_key)}
                    />
                  </>
                ) : (
                  String(o.age).trim() !== '' && (
                    <p className="text-xs text-muted-foreground">{t('occupants.childNote')}</p>
                  )
                )}
              </div>
            )
          })}

          {err('occupants') && <p className="text-xs text-destructive">{err('occupants')}</p>}
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={addOccupant}
            disabled={occupants.length >= MAX_OCCUPANTS}
          >
            <Plus className="size-4" />
            {t('occupants.add')}
          </Button>
        </Section>

        {/* House rules */}
        <Section title={data.rules?.title || t('rules.title')}>
          <div
            className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm"
            tabIndex={0}
            aria-label={t('rules.title')}
          >
            {data.rules?.body}
          </div>
          {data.signed ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-300">{t('rules.alreadyAccepted')}</p>
          ) : (
            <>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
                  checked={accepted}
                  onChange={(e) => {
                    setAccepted(e.target.checked)
                    touch('acceptance.accepted')
                  }}
                />
                <span>{t('rules.accept', { version: data.rules?.version ?? 1 })}</span>
              </label>
              <FieldError path="acceptance.accepted" />
              <Field label={t('rules.signature')} required hint={t('rules.signatureHint')}>
                <Input
                  className={INPUT_CLASS}
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  onBlur={() => touch('acceptance.typed_name')}
                  aria-invalid={!!err('acceptance.typed_name')}
                  autoComplete="off"
                  maxLength={120}
                />
                <FieldError path="acceptance.typed_name" />
              </Field>
            </>
          )}
        </Section>

        {submitError && (
          <div data-field-error className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {submitError}
          </div>
        )}

        <Button type="submit" className="h-12 w-full text-base" disabled={submitting}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? t('submitting') : data.submitted ? t('update') : t('submit')}
        </Button>
        {attempted && !validation.ok && (
          <p className="text-center text-xs text-destructive">{t('errors.fixFields')}</p>
        )}
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-xl px-4 py-6 sm:py-10">{children}</main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  // Tie the label to its control: the first element child gets the id.
  const id = useId()
  const items = Children.toArray(children)
  const firstIndex = items.findIndex((c) => isValidElement(c))
  const content = items.map((child, i) =>
    i === firstIndex && isValidElement<{ id?: string }>(child) ? cloneElement(child, { id }) : child,
  )
  return (
    <div className="space-y-1.5">
      <Label className="text-sm" htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {content}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Notice({
  title,
  body,
  icon,
  reference,
  refLabel,
}: {
  title: string
  body: string
  icon?: boolean
  reference?: string
  refLabel?: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center">
      {icon && <CheckCircle2 className="mx-auto mb-3 size-10 text-emerald-500" />}
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {reference && (
        <div className="mt-4 rounded-lg bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">{refLabel}</p>
          <p className="font-mono text-lg font-semibold">{reference}</p>
        </div>
      )}
    </div>
  )
}
