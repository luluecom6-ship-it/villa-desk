'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'

// Shown on the Stays page to admins when the villa's WhatsApp number is not
// working (PDR 8.5): paused, logged out, or not linked yet. Guest messages stay
// queued while this shows. Hidden when everything is fine or when the caller
// is not an admin (the status route then answers 403).
export function WhatsAppBanner() {
  const t = useTranslations('WhatsAppLink')
  const [problem, setProblem] = useState<'paused' | 'logged_out' | 'not_linked' | null>(null)

  useEffect(() => {
    let alive = true
    async function check() {
      try {
        const res = await fetch('/api/evolution/status', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const j = (await res.json()) as { status: string; serverReady: boolean }
        if (!alive) return
        setProblem(j.status === 'paused' || j.status === 'logged_out' || j.status === 'not_linked' ? j.status : null)
      } catch {
        /* no banner on a network error */
      }
    }
    void check()
    const id = setInterval(check, 30_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (!problem) return null
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {t(`banner.${problem}`)}{' '}
        <Link href="/settings?tab=link" className="font-medium underline">
          {t('banner.open')}
        </Link>
      </p>
    </div>
  )
}
