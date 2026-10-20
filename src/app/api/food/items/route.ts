// GET / POST /api/food/items (caretaker and above): the food menu.
//   GET   -> { items: [{ id, name, price, active, sortOrder }], imageUrl }
//   POST  { items: [{ id?, name, price, active }] } saves the whole list in the order given
//         (an item without id is new; a dish is switched off, never deleted, so past orders keep their names).
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const ctx = await requireRole('agent')
    const db = supabaseAdmin()
    const [{ data: rows }, { data: props }] = await Promise.all([
      db.from('food_items').select('id, name, price, active, sort_order, created_at').eq('account_id', ctx.accountId),
      db.from('properties').select('food_menu_image_url').eq('account_id', ctx.accountId).limit(1),
    ])
    const items = [...(rows ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || String(a.created_at).localeCompare(String(b.created_at)))
      .map((r) => ({ id: r.id as string, name: r.name as string, price: Number(r.price), active: !!r.active, sortOrder: r.sort_order as number }))
    return NextResponse.json({ items, imageUrl: (props?.[0]?.food_menu_image_url as string | null) ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as { items?: unknown } | null
    if (!body || !Array.isArray(body.items) || body.items.length > 100) return NextResponse.json({ error: 'Invalid menu.' }, { status: 400 })
    const clean: { id: string | null; name: string; price: number; active: boolean }[] = []
    for (const raw of body.items as Record<string, unknown>[]) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
      const price = Number(raw?.price)
      if (!name || name.length > 80) return NextResponse.json({ error: 'Every dish needs a name (up to 80 letters).' }, { status: 400 })
      if (!Number.isFinite(price) || price < 0 || price > 100000) return NextResponse.json({ error: `Check the price of “${name}”.` }, { status: 400 })
      const id = typeof raw?.id === 'string' && UUID.test(raw.id) ? raw.id : null
      clean.push({ id, name, price: Math.round(price * 100) / 100, active: raw?.active !== false })
    }
    const db = supabaseAdmin()
    const { data: existing } = await db.from('food_items').select('id').eq('account_id', ctx.accountId)
    const known = new Set((existing ?? []).map((r) => r.id as string))
    for (let i = 0; i < clean.length; i++) {
      const it = clean[i]
      if (it.id && known.has(it.id)) {
        const { error } = await db.from('food_items').update({ name: it.name, price: it.price, active: it.active, sort_order: i }).eq('id', it.id).eq('account_id', ctx.accountId)
        if (error) return NextResponse.json({ error: 'Could not save the menu.' }, { status: 500 })
      } else {
        const { error } = await db.from('food_items').insert({ account_id: ctx.accountId, name: it.name, price: it.price, active: it.active, sort_order: i })
        if (error) return NextResponse.json({ error: 'Could not save the menu.' }, { status: 500 })
      }
    }
    // Dishes left out of the list are switched off (never deleted: old orders keep their names).
    const kept = new Set(clean.map((c) => c.id).filter(Boolean) as string[])
    const dropped = [...known].filter((id) => !kept.has(id))
    if (dropped.length > 0) await db.from('food_items').update({ active: false }).in('id', dropped).eq('account_id', ctx.accountId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
