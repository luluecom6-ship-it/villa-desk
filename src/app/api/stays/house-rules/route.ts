import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { ensureProperty } from '@/lib/stays/server'

const t = getT('Stays')

export const MAX_RULES_BODY = 20_000

// House rules (PDR 6.4). Versions are append-only: publishing new wording
// creates version N+1, and each guest's acceptance stays tied to the exact
// version they signed. Nothing is edited or deleted.
//
// GET   any member: the latest version, or null if none is published yet.
// POST  admin and above: publish the next version.

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('house_rules_versions')
      .select('id, version, title, body, created_at')
      .eq('account_id', ctx.accountId)
      .order('version', { ascending: false })
      .limit(1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rules: data?.[0] ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const raw = await request.json().catch(() => null)
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: t('errors.invalidJson') }, { status: 400 })
  }
  const title = String((raw as { title?: unknown }).title ?? '').trim() || 'House rules'
  const body = String((raw as { body?: unknown }).body ?? '').trim()
  const fields: Record<string, string> = {}
  if (body.length < 20) fields.body = t('errors.rulesBodyShort')
  else if (body.length > MAX_RULES_BODY) fields.body = t('errors.tooLong')
  if (title.length > 120) fields.title = t('errors.tooLong')
  if (Object.keys(fields).length) {
    return NextResponse.json({ error: t('errors.fixFields'), fields }, { status: 400 })
  }

  try {
    const propertyId = await ensureProperty(ctx)
    // Two admins publishing at once: the unique (account, version) index makes
    // one of them lose, so retry a few times with a fresh version number.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: latest } = await ctx.supabase
        .from('house_rules_versions')
        .select('version')
        .eq('account_id', ctx.accountId)
        .order('version', { ascending: false })
        .limit(1)
      const version = (latest?.[0]?.version ?? 0) + 1
      const { data, error } = await ctx.supabase
        .from('house_rules_versions')
        .insert({
          account_id: ctx.accountId,
          property_id: propertyId,
          version,
          title,
          body,
          created_by: ctx.userId,
        })
        .select('id, version, title, body, created_at')
        .single()
      if (!error && data) return NextResponse.json({ rules: data }, { status: 201 })
      if (error?.code !== '23505') {
        return NextResponse.json({ error: error?.message ?? t('errors.updateFailed') }, { status: 500 })
      }
    }
    return NextResponse.json({ error: t('errors.updateFailed') }, { status: 409 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
