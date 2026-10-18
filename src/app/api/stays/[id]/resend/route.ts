import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resendToGuest, type ResendTarget } from '@/lib/stays/messaging/resend'

export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/stays/<id>/resend   caretakers (agent) and above.
// Body: { messageKey } to send a scheduled message again, or { guestId } to
// send the "ID rejected" message again. Answers { ok: true } or
// { ok: false, error, reason } so the screen can say why it did not go out.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
    const body = (await request.json().catch(() => null)) as { messageKey?: unknown; guestId?: unknown } | null
    let target: ResendTarget | null = null
    if (body && typeof body.messageKey === 'string') target = { type: 'message', messageKey: body.messageKey }
    else if (body && typeof body.guestId === 'string' && UUID.test(body.guestId)) target = { type: 'id_rejected', guestId: body.guestId }
    if (!target) return NextResponse.json({ ok: false, error: 'not_allowed' }, { status: 400 })

    const result = await resendToGuest(supabaseAdmin(), {
      accountId: ctx.accountId,
      stayId: id,
      target,
      requestUrl: request.url,
    })
    return NextResponse.json(result, { status: result.ok ? 200 : result.error === 'not_found' ? 404 : 409 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
