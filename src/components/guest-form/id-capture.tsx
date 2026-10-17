'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Camera, FileText, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PrepareError, prepareIdFile } from './prepare-file'

// One ID image slot (PDR 6.3): "Take photo" opens the rear camera on phones,
// "Upload file" opens the gallery / files. Both feed the same preview, with
// Retake and Remove. If a browser ignores `capture` (some desktops) the camera
// button simply opens the file picker, so it still works.

export interface IdSlot {
  file: File
  isPdf: boolean
  /** Object URL for the image preview (null for PDFs). */
  previewUrl: string | null
}

interface Props {
  label: string
  /** Newly chosen file, or null. */
  value: IdSlot | null
  onChange: (slot: IdSlot | null) => void
  /** A file for this slot is already on record from an earlier submit. */
  alreadyUploaded?: boolean
  required?: boolean
  error?: string
  disabled?: boolean
}

export function IdCapture({ label, value, onChange, alreadyUploaded, required, error, disabled }: Props) {
  const t = useTranslations('GuestForm')
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Free the preview's memory when it is replaced or the component goes away.
  useEffect(() => {
    const url = value?.previewUrl
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [value?.previewUrl])

  async function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = '' // so choosing the same file again still fires
    if (!picked) return
    setProblem(null)
    setBusy(true)
    try {
      const prepared = await prepareIdFile(picked)
      onChange({
        file: prepared.file,
        isPdf: prepared.isPdf,
        previewUrl: prepared.isPdf ? null : URL.createObjectURL(prepared.file),
      })
    } catch (err) {
      const code = err instanceof PrepareError ? err.problem : 'unreadable'
      setProblem(t(`capture.${code}`))
    } finally {
      setBusy(false)
    }
  }

  const hasSomething = !!value || !!alreadyUploaded
  const shownError = problem ?? error

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {label}
          {required && <span className="text-destructive"> *</span>}
        </span>
        {hasSomething && !disabled && (
          <span className="text-xs text-emerald-600 dark:text-emerald-300">
            {value ? t('capture.ready') : t('capture.onFile')}
          </span>
        )}
      </div>

      {value && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2">
          {value.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob preview
            <img
              src={value.previewUrl}
              alt={t('capture.previewAlt', { label })}
              className="size-16 shrink-0 rounded-md object-cover"
            />
          ) : (
            <div className="flex size-16 shrink-0 items-center justify-center rounded-md bg-muted">
              <FileText className="size-7 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 text-xs text-muted-foreground">
            <p className="truncate">{value.isPdf ? value.file.name : t('capture.photo')}</p>
            <p>{Math.max(1, Math.round(value.file.size / 1024))} KB</p>
          </div>
        </div>
      )}

      {/* Rear camera on phones. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handle}
        disabled={disabled}
        data-testid="id-camera-input"
      />
      {/* Gallery, files or a PDF. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handle}
        disabled={disabled}
        data-testid="id-file-input"
      />

      {!disabled && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => cameraRef.current?.click()}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
            {value ? t('capture.retake') : t('capture.takePhoto')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <Upload className="size-4" />
            {t('capture.uploadFile')}
          </Button>
        </div>
      )}

      {value && !disabled && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t('capture.remove')}
        </Button>
      )}

      {shownError && <p className="text-xs text-destructive">{shownError}</p>}
    </div>
  )
}
