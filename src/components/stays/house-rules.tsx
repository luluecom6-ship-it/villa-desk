'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_RULES_BODY, DEFAULT_RULES_TITLE } from '@/lib/stays/default-house-rules'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Rules {
  id: string
  version: number
  title: string
  body: string
}

// Banner + editor for the house rules guests must accept (PDR 6.4). Until a
// version is published the public guest form shows "not open yet", so every
// member sees a warning; admins get the editor. Publishing never edits an old
// version: it adds the next one, and signed acceptances keep theirs.
export function HouseRulesPanel({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('Stays')
  const [rules, setRules] = useState<Rules | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stays/house-rules')
      if (!res.ok) return
      const json = await res.json()
      setRules(json.rules ?? null)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function openEditor() {
    // Start from the current wording so a small change is a small edit.
    // First time: offer the Forms Pack wording to review (never auto-published).
    setTitle(rules?.title ?? DEFAULT_RULES_TITLE)
    setBody(rules?.body ?? DEFAULT_RULES_BODY)
    setFieldError(null)
    setOpen(true)
  }

  async function publish() {
    setSaving(true)
    setFieldError(null)
    try {
      const res = await fetch('/api/stays/house-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const first = json.fields ? (Object.values(json.fields as Record<string, string>)[0] as string) : null
        setFieldError(first ?? json.error ?? t('toast.saveFailed'))
        return
      }
      toast.success(t('drawer.houseRulesPublished', { version: json.rules.version }))
      setRules(json.rules)
      setOpen(false)
    } catch {
      setFieldError(t('toast.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <>
      {!rules ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <p className="font-medium">{t('drawer.houseRulesWarningTitle')}</p>
              <p className="text-muted-foreground">{t('drawer.houseRulesWarning')}</p>
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={openEditor} className="w-full sm:w-auto">
              {t('drawer.houseRulesPublish')}
            </Button>
          )}
        </div>
      ) : (
        isAdmin && (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{t('drawer.houseRulesCurrent', { version: rules.version })}</span>
            <Button size="sm" variant="outline" onClick={openEditor}>
              <ScrollText className="size-4" />
              {t('drawer.houseRulesManage')}
            </Button>
          </div>
        )
      )}

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('drawer.houseRulesPublish')}</DialogTitle>
              <DialogDescription>{t('drawer.houseRulesNewVersionNote')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="rules-title">
                  {t('drawer.houseRulesTitleLabel')}
                </label>
                <Input id="rules-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="rules-body">
                  {t('drawer.houseRulesBodyLabel')}
                </label>
                <Textarea
                  id="rules-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  maxLength={20000}
                />
              </div>
              {fieldError && <p className="text-sm text-destructive">{fieldError}</p>}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto">
                {t('drawer.houseRulesCancel')}
              </Button>
              <Button onClick={() => void publish()} disabled={saving || body.trim().length < 20} className="w-full sm:w-auto">
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t('drawer.houseRulesPublishButton')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
