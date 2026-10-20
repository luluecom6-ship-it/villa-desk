import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { MESSAGE_KEYS, type MessageKey } from '@/lib/stays/messaging/schedule'
import { checkTemplateBody, DEFAULT_TEMPLATES, REQUIRED_VARIABLES, TEMPLATE_VARIABLES } from '@/lib/stays/messaging/templates'

// Guest / staff message wording. Owner and admin only. No row = built-in text; "reset" removes the override.
const isKey = (v: unknown): v is MessageKey => (MESSAGE_KEYS as readonly string[]).includes(String(v))

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data } = await supabaseAdmin().from('stay_message_templates').select('message_key, body, updated_at').eq('account_id', ctx.accountId)
    const over = new Map(((data ?? []) as Array<{ message_key: string; body: string; updated_at: string }>).map((r) => [r.message_key, r]))
    return NextResponse.json({
      variables: TEMPLATE_VARIABLES,
      templates: MESSAGE_KEYS.map((key) => ({ key, default_body: DEFAULT_TEMPLATES[key], body: over.get(key)?.body ?? null, required: REQUIRED_VARIABLES[key] ?? null })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json().catch(() => null)) as { key?: unknown; body?: unknown } | null
    if (!b || !isKey(b.key)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const check = checkTemplateBody(b.key, b.body)
    if (!check.ok) return NextResponse.json({ error: check.error, detail: check.detail }, { status: 400 })
    const { error } = await supabaseAdmin()
      .from('stay_message_templates')
      .upsert({ account_id: ctx.accountId, message_key: b.key, body: check.body, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'account_id,message_key' })
    if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    return NextResponse.json({ ok: true, body: check.body })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const key = new URL(request.url).searchParams.get('key')
    if (!isKey(key)) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    const { error } = await supabaseAdmin().from('stay_message_templates').delete().eq('account_id', ctx.accountId).eq('message_key', key)
    if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
