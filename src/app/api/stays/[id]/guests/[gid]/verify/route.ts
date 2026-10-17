import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const t = getT('Stays')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Staff ID review (PDR 6.5). Admin and above.
//   { action: 'verify' }                 needs a live front image on file
//   { action: 'reject', reason: '...' }  the guest is asked to resubmit
// Verified and rejected are mutually exclusive (database constraint). A new
// upload by the guest clears both, putting the guest back in the queue.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; gid: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id, gid } = await params
  if (!UUID.test(id) || !UUID.test(gid)) {
    return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })
  }

  const raw = await request.json().catch(() => null)
  const action = (raw as { action?: unknown } | null)?.action
  if (action !== 'verify' && action !== 'reject') {
    return NextResponse.json({ error: t('errors.invalidJson') }, { status: 400 })
  }
  const reason = String((raw as { reason?: unknown }).reason ?? '').trim()
  if (action === 'reject' && (reason.length < 3 || reason.length > 300)) {
    return NextResponse.json(
      { error: t('errors.fixFields'), fields: { reason: t('errors.rejectReason') } },
      { status: 400 },
    )
  }

  try {
    const { data: guest } = await ctx.supabase
      .from('stay_guests')
      .select('id')
      .eq('id', gid)
      .eq('stay_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!guest) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    if (action === 'verify') {
      const { data: front } = await ctx.supabase
        .from('stay_documents')
        .select('id')
        .eq('guest_id', gid)
        .eq('side', 'front')
        .is('superseded_at', null)
        .limit(1)
      if (!front || front.length === 0) {
        return NextResponse.json({ error: t('errors.noIdToVerify') }, { status: 409 })
      }
    }

    const now = new Date().toISOString()
    const patch =
      action === 'verify'
        ? { id_verified_at: now, id_verified_by: ctx.userId, id_rejected_at: null, id_reject_reason: null }
        : { id_verified_at: null, id_verified_by: null, id_rejected_at: now, id_reject_reason: reason }

    const { data, error } = await ctx.supabase
      .from('stay_guests')
      .update(patch)
      .eq('id', gid)
      .eq('stay_id', id)
      .eq('account_id', ctx.accountId)
      .select('id, id_verified_at, id_rejected_at, id_reject_reason')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? t('errors.updateFailed') }, { status: 500 })
    }
    return NextResponse.json({ guest: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
