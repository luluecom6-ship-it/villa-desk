// GET / POST /api/property (admin+): the villa's own details that go into guest messages:
// address, map link, directions, WiFi and lock / gate instructions, caretaker phone, check-in
// and check-out times, review link, deposit refund days. One property per account.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const TEXT_FIELDS = { name: 120, address: 500, map_url: 500, directions: 1000, access_instructions: 1500, review_url: 500 } as const
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data } = await supabaseAdmin()
      .from('properties')
      .select('id, name, address, map_url, directions, access_instructions, caretaker_phone, review_url, default_checkin_time, default_checkout_time, deposit_refund_days')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
      .limit(1)
    const p = data?.[0]
    return NextResponse.json({
      property: {
        name: p?.name ?? '',
        address: p?.address ?? '',
        map_url: p?.map_url ?? '',
        directions: p?.directions ?? '',
        access_instructions: p?.access_instructions ?? '',
        caretaker_phone: p?.caretaker_phone ?? '',
        review_url: p?.review_url ?? '',
        default_checkin_time: (p?.default_checkin_time ?? '14:00').slice(0, 5),
        default_checkout_time: (p?.default_checkout_time ?? '11:00').slice(0, 5),
        deposit_refund_days: p?.deposit_refund_days ?? 3,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!b) return NextResponse.json({ error: 'Invalid details.' }, { status: 400 })
    const patch: Record<string, unknown> = {}
    for (const [k, max] of Object.entries(TEXT_FIELDS)) {
      if (b[k] === undefined) continue
      if (typeof b[k] !== 'string' || (b[k] as string).length > max) return NextResponse.json({ error: `${k} is too long or not text.` }, { status: 400 })
      patch[k] = (b[k] as string).trim() || null
    }
    if (patch.name === null) return NextResponse.json({ error: 'The villa needs a name.' }, { status: 400 })
    if (b.caretaker_phone !== undefined) {
      const digits = String(b.caretaker_phone ?? '').replace(/\D/g, '')
      if (digits && (digits.length < 8 || digits.length > 15)) return NextResponse.json({ error: "Enter the caretaker's number with country code, digits only." }, { status: 400 })
      patch.caretaker_phone = digits ? `+${digits}` : null
    }
    for (const k of ['default_checkin_time', 'default_checkout_time'] as const) {
      if (b[k] === undefined) continue
      if (typeof b[k] !== 'string' || !TIME.test(b[k] as string)) return NextResponse.json({ error: 'Times look like 14:00.' }, { status: 400 })
      patch[k] = b[k]
    }
    if (b.deposit_refund_days !== undefined) {
      const n = Number(b.deposit_refund_days)
      if (!Number.isInteger(n) || n < 0 || n > 60) return NextResponse.json({ error: 'Refund days must be a whole number.' }, { status: 400 })
      patch.deposit_refund_days = n
    }
    const db = supabaseAdmin()
    const { data: existing } = await db.from('properties').select('id').eq('account_id', ctx.accountId).order('created_at', { ascending: true }).limit(1)
    const id = existing?.[0]?.id as string | undefined
    const { error } = id
      ? await db.from('properties').update(patch).eq('id', id).eq('account_id', ctx.accountId)
      : await db.from('properties').insert({ account_id: ctx.accountId, name: 'Villa', ...patch })
    if (error) return NextResponse.json({ error: 'Could not save the villa details.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
