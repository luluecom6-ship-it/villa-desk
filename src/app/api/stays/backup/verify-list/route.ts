import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkCronSecret } from '@/lib/stays/backup/auth'
import { loadVerifyList } from '@/lib/stays/backup/server'

// n8n weekly Drive check, step 1 (header x-cron-secret): the Drive file ids that should still exist.
export async function GET(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied
  return NextResponse.json({ files: await loadVerifyList(supabaseAdmin()) }, { headers: { 'Cache-Control': 'no-store' } })
}
