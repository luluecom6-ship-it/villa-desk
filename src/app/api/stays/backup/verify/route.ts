import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkCronSecret } from '@/lib/stays/backup/auth'
import { applyVerifyResults } from '@/lib/stays/backup/server'

export const maxDuration = 60

// n8n weekly Drive check, step 2 (header x-cron-secret). Body { results: [{ id, exists }] }.
export async function POST(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { results?: unknown } | null
  if (!body || !Array.isArray(body.results)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  return NextResponse.json(await applyVerifyResults(supabaseAdmin(), body.results as Array<{ id?: unknown; exists?: unknown }>))
}
