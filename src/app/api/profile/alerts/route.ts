// GET / POST /api/profile/alerts — the signed-in person's own alert settings for guest messages.
//   alertPhone  WhatsApp number (digits + country code) that gets the alert from the villa number; null = bell only
//   available   false = off duty: skipped when choosing who is told first
//   escalateAfterMinutes  (admin and above) how long to wait before moving on to the next person
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { hasMinRole } from '@/lib/auth/roles'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const db = supabaseAdmin()
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const { data: me } = await db.from('profiles').select('alert_phone, available').eq('user_id', ctx.userId).maybeSingle()
    let minutes: number | null = null
    if (isAdmin) {
      const { data } = await db.from('properties').select('escalate_after_minutes').eq('account_id', ctx.accountId).limit(1)
      minutes = (data?.[0] as { escalate_after_minutes?: number } | undefined)?.escalate_after_minutes ?? 10
    }
    return NextResponse.json({
      alertPhone: me?.alert_phone ?? null,
      available: me?.available !== false,
      isAdmin,
      isAgent: ctx.role === 'agent',
      escalateAfterMinutes: minutes,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!b || typeof b.available !== 'boolean') return NextResponse.json({ error: 'Invalid settings.' }, { status: 400 })

    const rawPhone = typeof b.alertPhone === 'string' ? b.alertPhone.replace(/\D/g, '') : ''
    if (rawPhone && !/^[0-9]{8,15}$/.test(rawPhone)) {
      return NextResponse.json({ error: 'Enter the number with country code, digits only.' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { error } = await db
      .from('profiles')
      .update({ alert_phone: rawPhone || null, available: b.available })
      .eq('user_id', ctx.userId)
    if (error) return NextResponse.json({ error: 'Could not save.' }, { status: 500 })

    if (hasMinRole(ctx.role, 'admin') && b.escalateAfterMinutes !== undefined) {
      const m = b.escalateAfterMinutes
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 240) {
        return NextResponse.json({ error: 'Minutes must be between 1 and 240.' }, { status: 400 })
      }
      await db.from('properties').update({ escalate_after_minutes: m }).eq('account_id', ctx.accountId)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
