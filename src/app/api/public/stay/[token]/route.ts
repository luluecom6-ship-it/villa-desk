import { randomUUID } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  checkUpload,
  MAX_REQUEST_BYTES,
  sha256Hex,
  type SniffedType,
} from '@/lib/stays/files'
import { parseGuestForm } from '@/lib/stays/guest-form'
import { notifyFormSubmitted } from '@/lib/stays/messaging/form-submitted'
import { sendFormReceivedMessage } from '@/lib/stays/messaging/form-received'
import {
  findFormStay,
  FORM_BUCKET,
  getClientIp,
  isFormReadOnly,
  stayHasRejectedId,
  latestHouseRules,
  mapSubmitError,
  maskPhone,
} from '@/lib/stays/public-form'

const t = getT('GuestForm')

// Public guest form API (PDR 6 and 12.2). No login: the 14-character token in
// the URL is the only credential, so everything is rate limited per IP and an
// unknown / cancelled / finished token answers with the same neutral 404.
//
// GET   what the page needs to render the form (and to prefill a reopened one).
// POST  multipart: part "data" (JSON) plus one file part per ID image, named
//       "file:<guest_key>:<front|back>". Files are sniffed by content, stored
//       in the private bucket, then guests + documents + acceptance are
//       written in ONE database transaction (submit_stay_form, migration 052).

export const maxDuration = 30

const NO_STORE = { 'Cache-Control': 'no-store' }

// Vercel rejects request bodies above ~4.5 MB before they reach this code, so
// anything near that is a client that skipped the shrink step.
const MAX_BODY_BYTES = MAX_REQUEST_BYTES + 400_000

function notValid() {
  return NextResponse.json({ error: t('errors.notValid') }, { status: 404, headers: NO_STORE })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`stayform:${getClientIp(request)}`, RATE_LIMITS.stayForm)
  if (!limit.success) return rateLimitResponse(limit)

  const { token } = await params
  const admin = supabaseAdmin()
  const stay = await findFormStay(admin, token)
  if (!stay) return notValid()

  const [{ data: property }, rules, { data: guests }, { data: docs }, { data: acceptance }] =
    await Promise.all([
      admin.from('properties').select('name').eq('id', stay.property_id).maybeSingle(),
      latestHouseRules(admin, stay.account_id),
      admin
        .from('stay_guests')
        .select(
          'id, role, full_name, age, is_adult, email, nationality, address, id_type, id_last4, is_foreign, visa_type, visa_expiry, arrived_in_india_on, mobile, alternate_mobile, occupation, emergency_name, emergency_phone, id_verified_at, id_rejected_at, id_reject_reason',
        )
        .eq('stay_id', stay.id)
        .order('created_at', { ascending: true }),
      admin
        .from('stay_documents')
        .select('guest_id, side')
        .eq('stay_id', stay.id)
        .is('superseded_at', null),
      admin.from('stay_acceptances').select('id').eq('stay_id', stay.id).maybeSingle(),
    ])

  const lead = (guests ?? []).find((g) => g.role === 'lead') ?? null
  const occupants = (guests ?? []).filter((g) => g.role === 'occupant')

  const files: Record<string, { front: boolean; back: boolean }> = {}
  const keyFor = new Map<string, string>()
  if (lead) keyFor.set(lead.id as string, 'lead')
  occupants.forEach((o, i) => keyFor.set(o.id as string, `e${i + 1}`))
  for (const d of docs ?? []) {
    const key = keyFor.get(d.guest_id as string)
    if (!key) continue
    files[key] ??= { front: false, back: false }
    files[key][d.side as 'front' | 'back'] = true
  }

  // Where each adult's ID stands, so the guest only has to redo the rejected ones.
  const review: Record<string, { status: 'approved' | 'rejected' | 'pending'; reason?: string }> = {}
  for (const g of guests ?? []) {
    const key = keyFor.get(g.id as string)
    if (!key || !g.is_adult || !files[key]?.front) continue
    if (g.id_verified_at) review[key] = { status: 'approved' }
    else if (g.id_rejected_at) review[key] = { status: 'rejected', reason: (g.id_reject_reason as string | null) ?? '' }
    else review[key] = { status: 'pending' }
  }

  return NextResponse.json(
    {
      stay: {
        stay_ref: stay.stay_ref,
        guest_name: stay.guest_name,
        property_name: property?.name ?? null,
        checkin_at: stay.checkin_at,
        checkout_at: stay.checkout_at,
        guests_count: stay.guests_count,
        // The number is shown masked and cannot be changed from the form.
        mobile_masked: stay.guest_phone ? maskPhone(stay.guest_phone) : null,
      },
      rules: rules ? { id: rules.id, version: rules.version, title: rules.title, body: rules.body } : null,
      submitted: stay.form_status === 'submitted',
      read_only: isFormReadOnly(stay, new Date(), Object.values(review).some((r) => r.status === 'rejected')),
      signed: !!acceptance,
      existing: {
        lead: lead
          ? {
              full_name: lead.full_name,
              email: lead.email ?? '',
              is_foreign: !!lead.is_foreign,
              nationality: lead.is_foreign ? (lead.nationality ?? '') : '',
              address: lead.address ?? '',
              id_type: lead.id_type ?? '',
              id_last4: lead.id_last4 ?? '',
              visa_type: lead.visa_type ?? '',
              visa_expiry: lead.visa_expiry ?? '',
              arrived_in_india_on: lead.arrived_in_india_on ?? '',
              alternate_mobile: lead.alternate_mobile ?? '',
              occupation: lead.occupation ?? '',
              emergency_name: lead.emergency_name ?? '',
              emergency_phone: lead.emergency_phone ?? '',
            }
          : null,
        occupants: occupants.map((o, i) => ({
          client_key: `e${i + 1}`,
          id: o.id,
          full_name: o.full_name,
          age: o.age ?? '',
          id_type: o.id_type ?? '',
          id_last4: o.id_last4 ?? '',
          mobile: o.mobile ?? '',
        })),
        arrival: {
          expected_arrival_time: (stay.expected_arrival_time ?? '').slice(0, 5),
          vehicle_number: stay.vehicle_number ?? '',
          special_request: stay.special_request ?? '',
          purpose_of_visit: stay.purpose_of_visit ?? '',
        },
        files,
        review,
      },
    },
    { headers: NO_STORE },
  )
}

interface UploadedFile {
  path: string
  type: SniffedType
  size: number
  sha: string
}

/**
 * Remove files THIS request uploaded when the submit then fails. They were
 * never recorded in stay_documents, so nothing refers to them and leaving
 * ID images in the bucket with no record would only be a privacy hazard.
 * This is not a deletion of any recorded ID file (CLAUDE.md rule).
 */
async function discardUnrecordedUploads(
  admin: ReturnType<typeof supabaseAdmin>,
  paths: string[],
) {
  if (paths.length === 0) return
  const { error } = await admin.storage.from(FORM_BUCKET).remove(paths)
  if (error) console.error('[stay-form] could not clean up unrecorded uploads:', paths.length)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`stayform:${getClientIp(request)}`, RATE_LIMITS.stayForm)
  if (!limit.success) return rateLimitResponse(limit)

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: t('errors.requestTooLarge') }, { status: 413, headers: NO_STORE })
  }

  const { token } = await params
  const admin = supabaseAdmin()
  const stay = await findFormStay(admin, token)
  if (!stay) return notValid()
  if (isFormReadOnly(stay, new Date(), await stayHasRejectedId(admin, stay.id))) {
    return NextResponse.json({ error: t('errors.formClosed') }, { status: 409, headers: NO_STORE })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: t('errors.badRequest') }, { status: 400, headers: NO_STORE })
  }
  const rawData = form.get('data')
  let payload: unknown
  try {
    payload = typeof rawData === 'string' ? JSON.parse(rawData) : null
  } catch {
    payload = null
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: t('errors.badRequest') }, { status: 400, headers: NO_STORE })
  }

  const rules = await latestHouseRules(admin, stay.account_id)
  if (!rules) {
    return NextResponse.json({ error: t('errors.notOpenYet') }, { status: 503, headers: NO_STORE })
  }

  // What is already on record for this stay (a reopened form).
  const [{ data: guests }, { data: liveFronts }, { data: acceptance }] = await Promise.all([
    admin.from('stay_guests').select('id, role').eq('stay_id', stay.id),
    admin
      .from('stay_documents')
      .select('guest_id')
      .eq('stay_id', stay.id)
      .eq('side', 'front')
      .is('superseded_at', null),
    admin.from('stay_acceptances').select('id').eq('stay_id', stay.id).maybeSingle(),
  ])
  const frontGuestIds = new Set((liveFronts ?? []).map((d) => d.guest_id as string))
  const existingFronts: string[] = []
  const leadRow = (guests ?? []).find((g) => g.role === 'lead')
  if (leadRow && frontGuestIds.has(leadRow.id as string)) existingFronts.push('lead')
  const rawOcc = (payload as { occupants?: unknown }).occupants
  if (Array.isArray(rawOcc)) {
    for (const o of rawOcc) {
      const obj = (o ?? {}) as { id?: unknown; client_key?: unknown }
      if (typeof obj.id === 'string' && typeof obj.client_key === 'string' && frontGuestIds.has(obj.id)) {
        existingFronts.push(obj.client_key)
      }
    }
  }

  const parsed = parseGuestForm(payload, { alreadySigned: !!acceptance, existingFronts })
  if (!parsed.ok) {
    const fields = Object.fromEntries(
      Object.entries(parsed.errors).map(([path, key]) => [path, t(`errors.${key}`)]),
    )
    return NextResponse.json(
      { error: t('errors.fixFields'), fields },
      { status: 400, headers: NO_STORE },
    )
  }
  const input = parsed.value

  // The submitted form must be signed against the rules currently published.
  if (!acceptance && input.acceptance.rules_version_id !== rules.id) {
    return NextResponse.json({ error: t('errors.rulesChanged') }, { status: 409, headers: NO_STORE })
  }

  // ---- Files: presence, size, content type ------------------------------
  const staged: Array<{
    guest_key: string
    side: 'front' | 'back'
    bytes: Uint8Array
    type: SniffedType
  }> = []
  const fileErrors: Record<string, string> = {}
  let total = 0
  for (const doc of input.documents) {
    const part = form.get(`file:${doc.guest_key}:${doc.side}`)
    if (!part || typeof part === 'string') {
      fileErrors[`files.${doc.guest_key}.${doc.side}`] = t('errors.fileMissing')
      continue
    }
    const bytes = new Uint8Array(await (part as Blob).arrayBuffer())
    total += bytes.byteLength
    const check = checkUpload(bytes)
    if (!check.ok) {
      fileErrors[`files.${doc.guest_key}.${doc.side}`] = t(`errors.file_${check.problem}`)
      continue
    }
    staged.push({ guest_key: doc.guest_key, side: doc.side, bytes, type: check.type })
  }
  if (total > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: t('errors.requestTooLarge') }, { status: 413, headers: NO_STORE })
  }
  if (Object.keys(fileErrors).length > 0) {
    return NextResponse.json(
      { error: t('errors.fixFiles'), fields: fileErrors },
      { status: 400, headers: NO_STORE },
    )
  }

  // ---- Store files, then write the records in one transaction -----------
  const uploaded: Array<UploadedFile & { guest_key: string; side: 'front' | 'back' }> = []
  const prefix = `account-${stay.account_id}/${stay.id}/`
  try {
    for (const f of staged) {
      const path = `${prefix}${randomUUID()}.${f.type.ext}`
      const sha = await sha256Hex(f.bytes)
      const { error } = await admin.storage
        .from(FORM_BUCKET)
        .upload(path, f.bytes, { contentType: f.type.contentType, upsert: false })
      if (error) throw new Error('upload')
      uploaded.push({ path, type: f.type, size: f.bytes.byteLength, sha, guest_key: f.guest_key, side: f.side })
    }
  } catch {
    await discardUnrecordedUploads(admin, uploaded.map((u) => u.path))
    console.error('[stay-form] file upload failed')
    return NextResponse.json({ error: t('errors.saveFailed') }, { status: 500, headers: NO_STORE })
  }

  const { data: result, error: rpcError } = await admin.rpc('submit_stay_form', {
    p_token: token,
    p_form: {
      lead: input.lead,
      arrival: input.arrival,
      occupants: input.occupants,
      documents: uploaded.map((u) => ({
        guest_key: u.guest_key,
        side: u.side,
        storage_path: u.path,
        content_type: u.type.contentType,
        size_bytes: u.size,
        sha256: u.sha,
      })),
      acceptance: input.acceptance,
    },
    p_ip: getClientIp(request).slice(0, 64),
    p_user_agent: (request.headers.get('user-agent') ?? '').slice(0, 512),
  })

  if (rpcError) {
    await discardUnrecordedUploads(admin, uploaded.map((u) => u.path))
    const mapped = mapSubmitError(rpcError.message)
    // Log the code only: never ID numbers, file contents or phone numbers.
    console.error('[stay-form] submit failed:', /stay_form:[a-z_]+/.exec(rpcError.message)?.[0] ?? rpcError.code)
    return NextResponse.json(
      { error: t(`errors.${mapped.key}`) },
      { status: mapped.status, headers: NO_STORE },
    )
  }

  // Tell the team (bell + WhatsApp) once the response is out.
  const stayRef = (result as { stay_ref: string }).stay_ref
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin)
  after(async () => {
    try {
      await notifyFormSubmitted(admin, { accountId: stay.account_id, stayRef, guestName: stay.guest_name ?? null, siteUrl })
    } catch (e) {
      console.error('[stay-form] team alert failed:', (e as { code?: string })?.code ?? 'error')
    }
    try {
      await sendFormReceivedMessage(admin, { accountId: stay.account_id, stayId: stay.id })
    } catch (e) {
      console.error('[stay-form] receipt message failed:', (e as { code?: string })?.code ?? 'error')
    }
  })

  return NextResponse.json(
    { ok: true, stay_ref: (result as { stay_ref: string }).stay_ref },
    { headers: NO_STORE },
  )
}
