import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkCronSecret } from '@/lib/stays/backup/auth'
import { alertIfStorageHigh, loadPendingCopies } from '@/lib/stays/backup/server'

export const maxDuration = 60

// n8n nightly copy, step 1 (header x-cron-secret). Returns the ID files that have no verified Drive
// copy yet, each with a 10-minute download link, and runs the 70% / 90% storage alert check.
export async function GET(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied
  const db = supabaseAdmin()
  const files = await loadPendingCopies(db)
  const { data: props } = await db.from('properties').select('account_id')
  for (const a of new Set((props ?? []).map((p: { account_id: string }) => p.account_id))) {
    await alertIfStorageHigh(db, a).catch(() => undefined)
  }
  return NextResponse.json({ files }, { headers: { 'Cache-Control': 'no-store' } })
}
