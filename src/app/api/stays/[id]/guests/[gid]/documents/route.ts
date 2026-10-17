import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkUpload, MAX_PDF_BYTES, MAX_REQUEST_BYTES, sha256Hex } from '@/lib/stays/files'
import { FORM_BUCKET } from '@/lib/stays/public-form'

const t = getT('Stays')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const maxDuration = 30

// Staff attach an ID photo on a guest's behalf (caretaker, admin, owner).
// multipart: `side` = front | back, `file`. The file is checked by its first
// bytes, stored privately, then recorded by one database function that
// supersedes (never deletes) the previous file, sends the guest back to
// review and writes an audit row. If recording fails, only this request's own
// just-uploaded file is removed.
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
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES + 100_000) {
    return NextResponse.json({ error: t('errors.fileTooLarge') }, { status: 413 })
  }

  const form = await request.formData().catch(() => null)
  const side = form?.get('side')
  const file = form?.get('file')
  if (!form || (side !== 'front' && side !== 'back') || !(file instanceof File)) {
    return NextResponse.json({ error: t('errors.invalidJson') }, { status: 400 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const check = checkUpload(bytes)
  if (!check.ok) {
    return NextResponse.json({ error: t(`errors.file_${check.problem}`) }, { status: 400 })
  }
  const isPdf = check.type.contentType === 'application/pdf'
  if (bytes.byteLength > (isPdf ? MAX_PDF_BYTES : MAX_REQUEST_BYTES)) {
    return NextResponse.json({ error: t('errors.fileTooLarge') }, { status: 413 })
  }

  try {
    // Existence and account check through the caller's own session (RLS).
    const { data: guest } = await ctx.supabase
      .from('stay_guests')
      .select('id')
      .eq('id', gid)
      .eq('stay_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!guest) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    const admin = supabaseAdmin()
    const path = `account-${ctx.accountId}/${id}/${randomUUID()}.${check.type.ext}`
    const { error: upError } = await admin.storage
      .from(FORM_BUCKET)
      .upload(path, bytes, { contentType: check.type.contentType, upsert: false })
    if (upError) {
      console.error('[stay-doc] upload failed')
      return NextResponse.json({ error: t('errors.documentSaveFailed') }, { status: 500 })
    }

    const { data: docId, error } = await admin.rpc('staff_attach_document', {
      p_account: ctx.accountId,
      p_stay: id,
      p_guest: gid,
      p_side: side,
      p_path: path,
      p_content_type: check.type.contentType,
      p_size: bytes.byteLength,
      p_sha256: await sha256Hex(bytes),
      p_user: ctx.userId,
      p_role: ctx.role,
    })
    if (error) {
      await admin.storage.from(FORM_BUCKET).remove([path]) // our own unrecorded upload only
      const locked = /stay_doc:locked/.test(error.message)
      console.error('[stay-doc] record failed:', /stay_doc:[a-z_]+/.exec(error.message)?.[0] ?? error.code)
      return NextResponse.json(
        { error: locked ? t('errors.stayLocked') : t('errors.documentSaveFailed') },
        { status: locked ? 409 : 500 },
      )
    }
    return NextResponse.json({ ok: true, document_id: docId }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
