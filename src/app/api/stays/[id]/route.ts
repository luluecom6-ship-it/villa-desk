import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getT } from '@/lib/i18n/translate'
import { parsePatchStay } from '@/lib/stays/validate'
import {
  decorateStay,
  GUEST_COLUMNS,
  isLivePhoneConflict,
  linkContact,
} from '@/lib/stays/server'
import type { StayWithGuests } from '@/lib/stays/types'

const t = getT('Stays')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Stay detail + edit (PDR 5.3 / 12.1).
//
// GET    any member. ID file metadata is returned only to admin and above;
//        the images themselves are never served from here (they go through
//        the signed-URL route, which logs every open).
// PATCH  admin and above. Edits details, adds / corrects / removes the
//        mobile number (the database trigger flips Draft <-> Registered, so
//        automation turns on or off immediately), pauses automation, or
//        cancels. There is no DELETE: cancelling is a status, never a delete.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })
    const ctx = await getCurrentAccount()
    const isAdmin = hasMinRole(ctx.role, 'admin')

    const { data, error } = await ctx.supabase
      .from('stays')
      .select(`*, stay_guests(${GUEST_COLUMNS})`)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    const [acceptance, documents] = await Promise.all([
      ctx.supabase
        .from('stay_acceptances')
        .select('typed_name, accepted_at, ip_address, rules_version_id, house_rules_versions(version)')
        .eq('stay_id', id)
        .maybeSingle(),
      // RLS returns nothing to roles below admin; the explicit check keeps
      // that guarantee visible here too.
      isAdmin
        ? ctx.supabase
            .from('stay_documents')
            .select('id, guest_id, side, content_type, size_bytes, uploaded_at')
            .eq('stay_id', id)
            .is('superseded_at', null)
        : Promise.resolve({ data: [] as unknown[] }),
    ])

    return NextResponse.json({
      stay: decorateStay(data as StayWithGuests, {
        requestUrl: request.url,
        includeLink: isAdmin,
      }),
      acceptance: acceptance.data ?? null,
      documents: documents.data ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('errors.invalidJson') }, { status: 400 })

  const parsed = parsePatchStay(body)
  if (!parsed.ok) {
    const errors = Object.fromEntries(
      Object.entries(parsed.errors).map(([field, key]) => [field, t(`errors.${key}`)]),
    )
    return NextResponse.json({ error: t('errors.fixFields'), fields: errors }, { status: 400 })
  }
  const patch = { ...parsed.value } as Record<string, unknown>

  try {
    const { data: current, error: loadError } = await ctx.supabase
      .from('stays')
      .select('id, status, guest_name, checkin_at, checkout_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
    if (!current) return NextResponse.json({ error: t('errors.notFound') }, { status: 404 })

    // A finished or cancelled stay is history: its details are not editable.
    if (current.status === 'cancelled' || current.status === 'checked_out') {
      return NextResponse.json({ error: t('errors.stayLocked') }, { status: 409 })
    }

    // Dates must stay in order when only one of them is being changed.
    const checkin = (patch.checkin_at as string | undefined) ?? current.checkin_at
    const checkout = (patch.checkout_at as string | undefined) ?? current.checkout_at
    if (new Date(checkout) <= new Date(checkin)) {
      return NextResponse.json(
        { error: t('errors.fixFields'), fields: { checkout_at: t('errors.checkoutBeforeCheckin') } },
        { status: 400 },
      )
    }

    // Keep the inbox link in step with a new / corrected number.
    if (typeof patch.guest_phone === 'string') {
      patch.contact_id = await linkContact(
        ctx.supabase,
        ctx,
        patch.guest_phone,
        (patch.guest_name as string | undefined) ?? current.guest_name,
      )
    }

    const { data, error } = await ctx.supabase
      .from('stays')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(`*, stay_guests(${GUEST_COLUMNS})`)
      .single()

    if (isLivePhoneConflict(error)) {
      return NextResponse.json({ error: t('errors.phoneInUse') }, { status: 409 })
    }
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? t('errors.updateFailed') }, { status: 500 })
    }

    return NextResponse.json({
      stay: decorateStay(data as StayWithGuests, { requestUrl: request.url, includeLink: true }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
