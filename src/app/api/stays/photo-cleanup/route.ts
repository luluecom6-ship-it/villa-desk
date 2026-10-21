import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { photoCleanupSummary, purgeOldPhotos } from '@/lib/stays/checklist/cleanup'

export const maxDuration = 60

// Old checklist / damage photos (stays checked out > 90 days ago). OWNER ONLY.
// GET   how many and how big (nothing is removed).
// POST  delete them (the server recomputes the list; the client sends no ids).
export async function GET() {
  try {
    const ctx = await requireRole('owner')
    return NextResponse.json(await photoCleanupSummary(supabaseAdmin(), ctx.accountId), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST() {
  try {
    const ctx = await requireRole('owner')
    return NextResponse.json(await purgeOldPhotos(supabaseAdmin(), { accountId: ctx.accountId, actor: ctx.userId }))
  } catch (err) {
    return toErrorResponse(err)
  }
}
