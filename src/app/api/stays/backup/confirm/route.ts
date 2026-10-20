import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkCronSecret } from '@/lib/stays/backup/auth'
import { confirmCopy } from '@/lib/stays/backup/server'

// n8n nightly copy, step 2 (header x-cron-secret). Body { id, drive_file_id, drive_url, size, md5 } (or sha256) is what
// n8n read from the Drive copy. Accepted only if the size and the checksum match the file we hold.
export async function POST(request: Request) {
  const denied = checkCronSecret(request)
  if (denied) return denied
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const r = await confirmCopy(supabaseAdmin(), body as Record<string, unknown>)
  if (r.ok) return NextResponse.json({ ok: true })
  return NextResponse.json({ ok: false, error: r.error }, { status: r.error === 'not_found' ? 404 : r.error === 'mismatch' ? 409 : 400 })
}
