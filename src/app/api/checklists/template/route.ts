import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { ensureProperty } from '@/lib/stays/server'
import { parseItems } from '@/lib/stays/checklist/logic'
import { loadTemplateItems } from '@/lib/stays/checklist/server'

// The villa's checklist template (rooms, appliances, meter readings). Caretakers read it; owner/admin edit it.
// Editing never changes checklists already started: each run keeps a snapshot.
export async function GET() {
  try {
    const ctx = await requireRole('agent')
    const propertyId = await ensureProperty(ctx)
    return NextResponse.json({ items: await loadTemplateItems(supabaseAdmin(), ctx.accountId, propertyId) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const parsed = parseItems(((await request.json().catch(() => null)) as { items?: unknown } | null)?.items)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const propertyId = await ensureProperty(ctx)
    const { error } = await supabaseAdmin()
      .from('checklist_templates')
      .upsert({ account_id: ctx.accountId, property_id: propertyId, items: parsed.items, updated_by: ctx.userId }, { onConflict: 'property_id' })
    if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    return NextResponse.json({ items: parsed.items })
  } catch (err) {
    return toErrorResponse(err)
  }
}
