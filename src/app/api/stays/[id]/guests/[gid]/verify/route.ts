import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendIdRejectedMessage } from '@/lib/stays/messaging/id-rejected'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

export const maxDuration = 60

const t = getT('Stays')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Staff ID review (PDR 6.5). Caretakers (agent) and above (owner decision 20 Oct 2026: the
// owner is often away, so caretakers approve / reject too). Runs with the service client
// because RLS only lets admins update guests; every query is pinned to the caller's account.
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
    ctx = await requireRole('agent')
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
    const db = supabaseAdmin()
    const { data: guest } = await db
      .from('stay_guests')
      .select('id')
      .eq('id', gid)
      .eq('stay_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!guest) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    if (action === 'verify') {
      const { data: front } = await db
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

    const { data, error } = await db
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
    // Permanent history of who decided what and why (migration 059). A failed write
    // must not undo the review itself; it is logged and the review stands.
    try {
      const admin = db
      const { data: me } = await admin.from('profiles').select('full_name').eq('user_id', ctx.userId).maybeSingle()
      const { error: histErr } = await admin.from('stay_id_reviews').insert({
        account_id: ctx.accountId,
        stay_id: id,
        guest_id: gid,
        action: action === 'verify' ? 'approved' : 'rejected',
        reason: action === 'reject' ? reason : null,
        reviewed_by: ctx.userId,
        reviewer_name: (me as { full_name?: string } | null)?.full_name ?? null,
      })
      if (histErr) console.error('[id-review] history write failed:', histErr.code)
    } catch {
      console.error('[id-review] history write failed')
    }
    if (action === 'reject') {
      // Tell the guest straight away (WhatsApp), with the reason and the upload link.
      const accountId = ctx.accountId
      after(async () => {
        try {
          await sendIdRejectedMessage(supabaseAdmin(), { accountId, stayId: id, guestId: gid, reason, requestUrl: request.url })
        } catch (e) {
          console.error('[id-rejected] message failed:', (e as { code?: string })?.code ?? 'error')
        }
      })
    }
    return NextResponse.json({ guest: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
