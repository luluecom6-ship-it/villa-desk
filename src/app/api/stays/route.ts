import { NextResponse, after } from 'next/server'
import { kickStayScheduler } from '@/lib/stays/messaging/kick'
import { notifyStayCreated } from '@/lib/stays/messaging/form-submitted'
import { supabaseAdmin } from '@/lib/automations/admin-client'
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
  closeFinishedStays,
  linkContact,
} from '@/lib/stays/server'
import type { StayWithGuests } from '@/lib/stays/types'

export const maxDuration = 60

const t = getT('Stays')

// Stays list + create (PDR 5.1 / 5.2 / 12.1).
//
// GET   any member. RLS scopes to the caller's account; caretakers (agent)
//       and viewers can read stays but never receive the guest-form link.
// POST  caretakers and above (writes use the service client). Saving generates the Stay Reference and form token
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

    // While staff use the app, keep scheduled messages moving (once a minute at most).
    const requestUrl = request.url
    after(() => kickStayScheduler(requestUrl, { lazy: true }))

    const all = (data ?? []) as StayWithGuests[]
    const now = new Date()
    const includeLink = hasMinRole(ctx.role, 'admin')
    // Deposit status is owner/admin only: it powers the "Deposit to refund" filter.
    if (includeLink) {
      const { data: deps } = await supabaseAdmin().from('deposits').select('stay_id, status').eq('account_id', ctx.accountId)
      const byStay = new Map((deps ?? []).map((d: { stay_id: string; status: string }) => [d.stay_id, d.status]))
      for (const s of all) s.deposit_status = byStay.get(s.id) ?? null
    }
    const stays = filterStays(all, filter, q, now).map((s) =>
      decorateStay(s, { requestUrl: request.url, includeLink, now }),
    )
    const counts = filterCounts(all, now)
    if (!includeLink) delete counts.deposit_refund
    return NextResponse.json({ stays, counts })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    // Caretakers (agent) may register stays too; their writes go through the service client after this check.
    ctx = await requireRole('agent')
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
  const db = supabaseAdmin()

  try {
    const propertyId = await ensureProperty({ ...ctx, supabase: db })

    const contactId = input.guest_phone
      ? await linkContact(db, ctx, input.guest_phone, input.guest_name)
      : null

    // stay_ref, form_token and the draft/registered status are assigned by
    // the database trigger; nothing here lets the client choose them.
    const insertStay = () =>
      db
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
    let { data, error } = await insertStay()

    // Returning guest whose last stay is over but never marked checked out.
    if (isLivePhoneConflict(error) && input.guest_phone) {
      const closed = await closeFinishedStays(db, ctx.accountId, input.guest_phone)
      if (closed > 0) ({ data, error } = await insertStay())
    }

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
      const { count } = await db
        .from('stays')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('source', input.source)
        .ilike('external_booking_ref', input.external_booking_ref.replace(/[\\%_]/g, '\\$&'))
        .neq('id', data.id)
      if ((count ?? 0) > 0) warnings.push(t('errors.duplicateBookingRef'))
    }

    // Tell the rest of the team a registration was created.
    {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin
      after(async () => {
        try {
          await notifyStayCreated(supabaseAdmin(), {
            accountId: ctx.accountId,
            stayRef: data.stay_ref,
            guestName: data.guest_name,
            checkin: data.checkin_at,
            formSent: !!data.guest_phone,
            createdBy: ctx.userId,
            siteUrl,
          })
        } catch (e) {
          console.error('[stays] team alert failed:', (e as { code?: string })?.code ?? 'error')
        }
      })
    }

    // A registered stay (it has a mobile number) sends its first message now.
    if (data.guest_phone) {
      const requestUrl = request.url
      after(() => kickStayScheduler(requestUrl))
    }

    return NextResponse.json(
      {
        stay: decorateStay(data as StayWithGuests, {
          requestUrl: request.url,
          includeLink: hasMinRole(ctx.role, 'admin'),
        }),
        warnings,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
