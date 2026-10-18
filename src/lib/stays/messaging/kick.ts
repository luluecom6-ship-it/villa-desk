import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runStayScheduler } from './scheduler'

// Runs the stay scheduler right now, so a new registration (or a corrected
// mobile number) sends its first message at once instead of waiting for the
// next external cron call. Safe to run alongside the cron: every message is
// claimed before it is sent, so it goes out once.
//
// `lazy` runs are throttled to one a minute per server process. They make
// scheduled messages keep moving while staff use the app, but the external
// cron (docs/villa-scheduler.md) is still what covers the quiet hours.

let lastLazyRun = 0

export async function kickStayScheduler(requestUrl: string, opts: { lazy?: boolean } = {}): Promise<void> {
  if (opts.lazy) {
    const now = Date.now()
    if (now - lastLazyRun < 60_000) return
    lastLazyRun = now
  }
  try {
    await runStayScheduler(supabaseAdmin(), { requestUrl })
  } catch (err) {
    console.error('[stay-kick] failed:', (err as { code?: string })?.code ?? 'error')
  }
}
