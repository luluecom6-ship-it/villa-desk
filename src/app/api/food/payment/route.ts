// GET / PUT /api/food/payment (owner / admin): the UPI ID guests pay food orders to.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { cleanUpiId } from '@/lib/stays/food/logic'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data } = await supabaseAdmin().from('properties').select('upi_id, upi_payee_name, food_send_upi_qr').eq('account_id', ctx.accountId).order('created_at', { ascending: true }).limit(1)
    const p = data?.[0]
    return NextResponse.json({ upiId: p?.upi_id ?? '', payeeName: p?.upi_payee_name ?? '', sendQr: p?.food_send_upi_qr ?? true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json().catch(() => null)) as { upiId?: unknown; payeeName?: unknown; sendQr?: unknown } | null
    if (!b) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    const raw = typeof b.upiId === 'string' ? b.upiId.trim() : ''
    const upiId = raw === '' ? null : cleanUpiId(raw)
    if (raw !== '' && !upiId) return NextResponse.json({ error: 'That does not look like a UPI ID. It should be like name@bank.' }, { status: 400 })
    const payee = typeof b.payeeName === 'string' ? b.payeeName.trim().slice(0, 50) : ''
    const patch = { upi_id: upiId, upi_payee_name: payee || null, food_send_upi_qr: b.sendQr !== false }
    const db = supabaseAdmin()
    const { data } = await db.from('properties').select('id').eq('account_id', ctx.accountId).order('created_at', { ascending: true }).limit(1)
    const id = data?.[0]?.id as string | undefined
    const { error } = id ? await db.from('properties').update(patch).eq('id', id) : await db.from('properties').insert({ account_id: ctx.accountId, name: 'Villa', ...patch })
    if (error) return NextResponse.json({ error: 'Could not save.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
