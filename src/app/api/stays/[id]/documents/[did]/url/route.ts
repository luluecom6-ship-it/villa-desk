import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { FORM_BUCKET } from '@/lib/stays/public-form'

const t = getT('Stays')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const SIGNED_URL_SECONDS = 60

// The only way an ID image leaves the private bucket (PDR 13.3).
//
// POST so a link is never created by a prefetch or a page reload: one click,
// one request, one logged open. Caretaker and above. The access-log row is
// written BEFORE the link is created, and if the log cannot be written no link
// is issued (fail closed). Links last 60 seconds. Viewers get 403.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; did: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id, did } = await params
  if (!UUID.test(id) || !UUID.test(did)) {
    return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })
  }

  try {
    // Look the document up through the caller's own session so RLS and the
    // account check both apply; it must belong to this stay and be live.
    const { data: doc } = await ctx.supabase
      .from('stay_documents')
      .select('id, stay_id, account_id, storage_path, content_type, superseded_at')
      .eq('id', did)
      .eq('stay_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    const admin = supabaseAdmin()

    const { error: logError } = await admin.from('document_access_log').insert({
      account_id: ctx.accountId,
      stay_id: id,
      document_id: did,
      opened_by: ctx.userId,
      opened_role: ctx.role,
      action: 'signed_url',
    })
    if (logError) {
      console.error('document_access_log insert failed', logError.code)
      return NextResponse.json({ error: t('errors.documentUnavailable') }, { status: 503 })
    }

    const { data: signed, error: signError } = await admin.storage
      .from(FORM_BUCKET)
      .createSignedUrl(doc.storage_path as string, SIGNED_URL_SECONDS)
    if (signError || !signed?.signedUrl) {
      console.error('createSignedUrl failed', signError?.name)
      return NextResponse.json({ error: t('errors.documentUnavailable') }, { status: 502 })
    }

    return NextResponse.json(
      {
        url: signed.signedUrl,
        expires_in: SIGNED_URL_SECONDS,
        content_type: doc.content_type,
        superseded: !!doc.superseded_at,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
