import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { storePhoto, UUID } from '@/lib/stays/checklist/server'

// POST multipart { file }: a photo for a damage report. Caretaker and above.
export async function POST(request: Request, { params }: { params: Promise<{ did: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const { did } = await params
    if (!UUID.test(did)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const file = (await request.formData().catch(() => null))?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const db = supabaseAdmin()
    const { data: d } = await db.from('damage_reports').select('id, stay_id').eq('id', did).eq('account_id', ctx.accountId).maybeSingle()
    if (!d) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const res = await storePhoto(db, { accountId: ctx.accountId, stayId: (d as { stay_id: string }).stay_id, damageId: did, file, userId: ctx.userId })
    return res.ok ? NextResponse.json({ ok: true, photo_id: res.id }, { status: 201 }) : NextResponse.json({ error: res.error }, { status: res.status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
