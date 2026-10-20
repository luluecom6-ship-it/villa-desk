import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { storageSummary } from '@/lib/stays/backup/server'

// Storage meter for Settings (owner and admin).
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    return NextResponse.json(await storageSummary(supabaseAdmin(), ctx.accountId), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
