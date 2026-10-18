// GET / POST /api/team/alerts: the owner or an admin sets each team member's WhatsApp number
// for guest messages, and whether they are on duty (migration 058). Everyone can still change
// their own in Settings -> Profile.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('profiles')
      .select('user_id, full_name, email, account_role, alert_phone, available, created_at')
      .eq('account_id', ctx.accountId)
      .in('account_role', ['owner', 'admin', 'agent'])
      .order('created_at', { ascending: true })
    if (error) return NextResponse.json({ error: 'Could not load the team.' }, { status: 500 })
    return NextResponse.json({
      members: (data ?? []).map((p) => ({
        userId: p.user_id,
        name: p.full_name || p.email || 'Team member',
        role: p.account_role,
        alertPhone: p.alert_phone ?? null,
        available: p.available !== false,
        isMe: p.user_id === ctx.userId,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!b || typeof b.userId !== 'string' || !UUID.test(b.userId) || typeof b.available !== 'boolean') {
      return NextResponse.json({ error: 'Invalid settings.' }, { status: 400 })
    }
    const phone = typeof b.alertPhone === 'string' ? b.alertPhone.replace(/\D/g, '') : ''
    if (phone && !/^[0-9]{8,15}$/.test(phone)) {
      return NextResponse.json({ error: 'Enter the number with country code, digits only.' }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin()
      .from('profiles')
      .update({ alert_phone: phone || null, available: b.available })
      .eq('user_id', b.userId)
      .eq('account_id', ctx.accountId)
      .select('user_id')
    if (error) return NextResponse.json({ error: 'Could not save.' }, { status: 500 })
    if (!data || data.length === 0) return NextResponse.json({ error: 'Team member not found.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
