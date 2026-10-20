// POST /api/food/image (caretaker and above): upload the menu picture sent to guests (multipart, field "file").
// DELETE removes it from the menu (the file stays in storage).
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { buildMediaPath } from '@/lib/storage/upload-media'

export const maxDuration = 30

const MAX_BYTES = 4 * 1024 * 1024 // Vercel caps a request body at 4.5 MB
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

async function setUrl(accountId: string, url: string | null): Promise<boolean> {
  const db = supabaseAdmin()
  const { data } = await db.from('properties').select('id').eq('account_id', accountId).order('created_at', { ascending: true }).limit(1)
  const id = data?.[0]?.id as string | undefined
  const { error } = id
    ? await db.from('properties').update({ food_menu_image_url: url }).eq('id', id)
    : await db.from('properties').insert({ account_id: accountId, name: 'Villa', food_menu_image_url: url })
  return !error
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a picture.' }, { status: 400 })
    const ext = TYPES[file.type]
    if (!ext) return NextResponse.json({ error: 'Use a JPG, PNG or WebP picture.' }, { status: 400 })
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'The picture is over 4 MB. Make it smaller and try again.' }, { status: 413 })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = buildMediaPath(ctx.accountId, `food-menu.${ext}`, Date.now(), 'food')
    const storage = supabaseAdmin().storage.from('chat-media')
    const { error } = await storage.upload(path, bytes, { contentType: file.type, cacheControl: '3600', upsert: false })
    if (error) return NextResponse.json({ error: 'Could not store the picture.' }, { status: 500 })
    const url = storage.getPublicUrl(path).data.publicUrl
    if (!(await setUrl(ctx.accountId, url))) return NextResponse.json({ error: 'Could not save the picture.' }, { status: 500 })
    return NextResponse.json({ ok: true, imageUrl: url })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('agent')
    if (!(await setUrl(ctx.accountId, null))) return NextResponse.json({ error: 'Could not remove the picture.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
