import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkCronSecret } from '@/lib/stays/backup/auth'
import { buildExport } from '@/lib/stays/backup/server'

export const maxDuration = 60

// n8n weekly database export (header x-cron-secret): stays, guests, acceptances, deposits and logs as JSON, to be
// saved in the Drive folder. No ID images. Free Supabase has no backups, so this is the safety copy.
export async function GET(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied
  const body = JSON.stringify(await buildExport(supabaseAdmin()))
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="villa-desk-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
