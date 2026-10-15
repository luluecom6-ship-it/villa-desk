import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getT } from '@/lib/i18n/translate'
import { filterStays, isStayFilter } from '@/lib/stays/filters'
import { parseCreateStay } from '@/lib/stays/validate'
import {
  decorateStay,
  ensureProperty,
  filterCounts,
  GUEST_COLUMNS,
  isLivePhoneConflict,
  linkContact,
} from '@/lib/stays/server'
import type { StayWithGuests } from '@/lib/stays/types'

const t = getT('Stays')

// Stays list + create (PDR 5.1 / 5.2 / 12.1).
//
// GET   any member. RLS scopes to the caller's account; caretakers (agent)
//       and viewers can read stays but never receive the guest-form link.
// POST  admin and above. Saving generates the Stay Reference and form token
//       in the database; a registration without a mobile is stored as Draft
//       with automation off.

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const filterParam = url.searchParams.get('filter') ?? 'all'
    const filter = isStayFilter(filterParam) ? filterParam : 'all'
    const q = (url.searchParams.get('q') ?? '').slice(0, 100)

    const { data, error } = await ctx.supabase
      .from('stays')
      .select(`*, stay_guests(${GUEST_COLUMNS})`)
      .eq('account_id', ctx.accountId)
      .order('checkin_at', { ascending: false })
      .limit(1000)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const all = (data ?? []) as StayWithGuests[]
    const now = new Date()
    const includeLink = hasMinRole(ctx.role, 'admin')
    const stays = filterStays(all, filter, q, now).map((s) =>
      decorateStay(s, { requestUrl: request.url, includeLink, now }),
    )
    return NextResponse.json({ stays, counts: filterCounts(all, now) })
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

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: t('errors.invalidJson') }, { status: 400 })
  }

  const parsed = parseCreateStay(body)
  if (!parsed.ok) {
    const errors = Object.fromEntries(
      Object.entries(parsed.errors).map(([field, key]) => [field, t(`errors.${key}`)]),
    )
    return NextResponse.json(
      { error: t('errors.fixFields'), fields: errors },
      { status: 400 },
    )
  }
  const input = parsed.value

  try {
    const propertyId = await ensureProperty(ctx)

    const contactId = input.guest_phone
      ? await linkContact(ctx.supabase, ctx, input.guest_phone, input.guest_name)
      : null

    // stay_ref, form_token and the draft/registered status are assigned by
    // the database trigger; nothing here lets the client choose them.
    const { data, error } = await ctx.supabase
      .from('stays')
      .insert({
        account_id: ctx.accountId,
        property_id: propertyId,
        contact_id: contactId,
        created_by: ctx.userId,
        ...input,
      })
      .select(`*, stay_guests(${GUEST_COLUMNS})`)
      .single()

    if (isLivePhoneConflict(error)) {
      return NextResponse.json({ error: t('errors.phoneInUse') }, { status: 409 })
    }
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? t('errors.createFailed') },
        { status: 500 },
      )
    }

    // Duplicate platform references are allowed (platforms reuse a reference
    // when a booking is modified) but flagged, per PDR section 11.
    const warnings: string[] = []
    if (input.external_booking_ref) {
      const { count } = await ctx.supabase
        .from('stays')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('source', input.source)
        .ilike('external_booking_ref', input.external_booking_ref.replace(/[\\%_]/g, '\\$&'))
        .neq('id', data.id)
      if ((count ?? 0) > 0) warnings.push(t('errors.duplicateBookingRef'))
    }

    return NextResponse.json(
      {
        stay: decorateStay(data as StayWithGuests, {
          requestUrl: request.url,
          includeLink: true,
        }),
        warnings,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
