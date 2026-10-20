'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { renderTemplate, SAMPLE_VALUES, unknownVariables } from '@/lib/stays/messaging/templates'

// Wording of the automatic WhatsApp messages. Owner / admin only. Empty override = built-in text.
interface Tpl { key: string; default_body: string; body: string | null; required: string | null }

const NAME: Record<string, string> = {
  form_link: 'Registration form link (sent on booking)',
  form_reminder_3d: 'Form reminder, 3 days before',
  form_reminder_2d: 'Form reminder, 2 days before',
  form_reminder_1d: 'Form reminder, 1 day before',
  arrival_info: 'Arrival information (day before)',
  access_details: 'Access details (arrival day)',
  arrival_check: 'Settling-in check',
  checkout_reminder: 'Check-out reminder',
  review_request: 'Review request',
  id_alert_staff: 'Staff alert: IDs to approve',
  owner_alert: 'Staff alert: registration incomplete',
}
const ERR: Record<string, string> = {
  empty: 'The message cannot be empty.',
  tooLong: 'Keep it under 2000 characters.',
  unknownVariable: 'Unknown variable',
  missingVariable: 'This message must keep',
}
const area = 'min-h-28 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function MessageTemplatesCard() {
  const [vars, setVars] = useState<string[]>([])
  const [tpls, setTpls] = useState<Tpl[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stays/templates', { cache: 'no-store' })
      if (!res.ok) return
      const j = await res.json()
      setVars(j.variables); setTpls(j.templates)
    } catch { /* hidden for non-admins */ }
  }, [])
  useEffect(() => { void (async () => { await load() })() }, [load])
  if (!tpls) return null

  const current = tpls.find((t) => t.key === open)
  async function save() {
    if (!current) return
    setBusy(true)
    const res = await fetch('/api/stays/templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: current.key, body: draft }) })
    setBusy(false)
    if (!res.ok) { const j = await res.json().catch(() => ({})); toast.error(`${ERR[j.error] ?? 'Could not save.'}${j.detail ? ` ${j.detail}` : ''}`); return }
    toast.success('Saved. Messages not yet sent will use this wording.')
    setOpen(null); await load()
  }
  async function reset() {
    if (!current) return
    setBusy(true)
    const res = await fetch(`/api/stays/templates?key=${current.key}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) { toast.error('Could not reset.'); return }
    toast.success('Back to the built-in wording.')
    setOpen(null); await load()
  }
  const bad = unknownVariables(draft)

  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <h2 className="text-sm font-semibold">Message wording</h2>
        <p className="text-xs text-muted-foreground">Change what guests (and the team) are sent automatically. Use the variables in curly brackets; they are filled in per guest.</p>
        <ul className="divide-y rounded-md border">
          {tpls.map((t) => (
            <li key={t.key}>
              <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { setOpen(t.key); setDraft(t.body ?? t.default_body) }}>
                <span>{NAME[t.key] ?? t.key}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t.body ? 'Customised' : 'Built-in'}</span>
              </button>
              {open === t.key && (
                <div className="space-y-2 border-t bg-muted/30 p-3">
                  <textarea className={area} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  {bad.length > 0 && <p className="text-xs text-red-600">Unknown variable: {bad.map((b) => `{${b}}`).join(', ')}</p>}
                  {t.required && <p className="text-xs text-muted-foreground">Must keep {`{${t.required}}`}.</p>}
                  <p className="text-xs text-muted-foreground">Variables: {vars.map((v) => `{${v}}`).join(' ')}</p>
                  <div className="whitespace-pre-wrap rounded-md border bg-background p-2 text-sm">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Preview</p>
                    {renderTemplate(draft, SAMPLE_VALUES)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="size-4 animate-spin" /> : 'Save'}</Button>
                    {t.body && <Button size="sm" variant="outline" disabled={busy} onClick={() => void reset()}>Use built-in wording</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
