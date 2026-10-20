// GET  /api/food/orders (caretaker and above): the latest orders, newest first.
// POST /api/food/orders { id, decision: 'confirmed' | 'declined', reason? }: approve or decline a waiting order.
//      The guest is told on WhatsApp; the answer says whether that message went out.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decideOrder } from '@/lib/stays/food/server'

export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const ctx = await requireRole('agent')
    const { data } = await supabaseAdmin()
      .from('food_orders')
      .select('id, order_no, guest_name, items, total, status, decided_by_name, decided_at, decline_reason, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(100)
    return NextResponse.json({
      orders: (data ?? []).map((o) => ({
        id: o.id, orderNo: o.order_no, guestName: o.guest_name, items: o.items, total: Number(o.total), status: o.status,
        decidedByName: o.decided_by_name, decidedAt: o.decided_at, declineReason: o.decline_reason, createdAt: o.created_at,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const b = (await request.json().catch(() => null)) as { id?: unknown; decision?: unknown; reason?: unknown } | null
    if (!b || typeof b.id !== 'string' || !UUID.test(b.id) || (b.decision !== 'confirmed' && b.decision !== 'declined')) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const { data: prof } = await db.from('profiles').select('full_name, email').eq('user_id', ctx.userId).eq('account_id', ctx.accountId).maybeSingle()
    const result = await decideOrder(db, {
      accountId: ctx.accountId,
      orderId: b.id,
      decision: b.decision,
      byUserId: ctx.userId,
      byName: (prof?.full_name as string | null) || (prof?.email as string | null) || null,
      reason: typeof b.reason === 'string' ? b.reason : null,
    })
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.error === 'not_found' ? 404 : 409 })
    return NextResponse.json({ ok: true, guestMessage: result.guestMessage })
  } catch (err) {
    return toErrorResponse(err)
  }
}
