'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Camera, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PrepareError, prepareIdFile } from '@/components/guest-form/prepare-file'

// Staff add an ID photo for a guest who could not do it themselves (PDR 6.3,
// owner decision: caretakers may upload on a guest's behalf). Same shrink and
// checks as the guest form, then one request per file. The new file replaces
// the old one for that side; the old one is kept as superseded.
export function StaffIdUpload({
  stayId,
  guestId,
  hasBack,
  hasFront,
  onUploaded,
}: {
  stayId: string
  guestId: string
  hasFront: boolean
  hasBack: boolean
  onUploaded: () => void
}) {
  const t = useTranslations('Stays')
  const [side, setSide] = useState<'front' | 'back'>(hasFront ? 'back' : 'front')
  const [busy, setBusy] = useState(false)
  const camera = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)

  async function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    setBusy(true)
    try {
      const prepared = await prepareIdFile(picked)
      const body = new FormData()
      body.set('side', side)
      body.set('file', prepared.file, prepared.file.name)
      const res = await fetch(`/api/stays/${stayId}/guests/${guestId}/documents`, { method: 'POST', body })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error ?? t('toast.uploadFailed'))
        return
      }
      toast.success(t('toast.idUploaded'))
      onUploaded()
    } catch (err) {
      toast.error(err instanceof PrepareError ? t(`drawer.prepare.${err.problem}`) : t('toast.uploadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-2">
      <p className="text-xs font-medium">{t('drawer.addIdTitle')}</p>
      <div className="flex gap-2">
        {(['front', 'back'] as const).map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={side === s ? 'default' : 'outline'}
            onClick={() => setSide(s)}
          >
            {s === 'front' ? t('drawer.idFront') : t('drawer.idBack')}
            {(s === 'front' ? hasFront : hasBack) ? ` ✓` : ''}
          </Button>
        ))}
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      <input ref={files} type="file" accept="image/*,application/pdf" className="hidden" onChange={handle} />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => camera.current?.click()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
          {t('drawer.takePhoto')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => files.current?.click()}>
          <Upload className="size-3.5" />
          {t('drawer.uploadFile')}
        </Button>
      </div>
      {(side === 'front' ? hasFront : hasBack) && (
        <p className="text-xs text-muted-foreground">{t('drawer.replaceNote')}</p>
      )}
    </div>
  )
}
