import type { SupabaseClient } from '@supabase/supabase-js'
import { sendIdRejectedDetailed } from './id-rejected'
import { buildValues } from './scheduler'
import { isStaffAlert, MESSAGE_KEYS, type MessageKey } from './schedule'
import { sendStayWhatsApp, type StayTransport } from './send'
import { DEFAULT_TEMPLATES, META_TEMPLATE_PARAMS, renderTemplate } from './templates'

// A caretaker or owner can send a guest message again when the guest says it
// never arrived. It is a manual action, so it ignores the "is this still
// needed" conditions the scheduler applies (staff know best), but it still goes
// through the one guest send function: the allow-list gate, the channel, the
// log. It is staff-initiated, so it is sent like a reply (no daily-limit wait).

export type ResendTarget =
  | { type: 'message'; messageKey: string }
  | { type: 'id_rejected'; guestId: string }

export type ResendResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'not_allowed' | 'no_mobile' | 'nothing_to_resend' | 'not_sent'; reason?: string }

export async function resendToGuest(
  db: SupabaseClient,
  args: { accountId: string; stayId: string; target: ResendTarget; requestUrl: string; transport?: StayTransport; now?: Date },
): Promise<ResendResult> {
  const now = args.now ?? new Date()
  const { data: stay } = await db
    .from('stays')
    .select('id, account_id, property_id, stay_ref, guest_name, guest_phone, form_token, status, form_status, checkin_at, checkout_at, created_at')
    .eq('id', args.stayId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!stay) return { ok: false, error: 'not_found' }
  if (!stay.guest_phone) return { ok: false, error: 'no_mobile' }

  if (args.target.type === 'id_rejected') {
    const { data: guest } = await db
      .from('stay_guests')
      .select('id, id_rejected_at, id_reject_reason')
      .eq('id', args.target.guestId)
      .eq('stay_id', stay.id)
      .maybeSingle()
    if (!guest) return { ok: false, error: 'not_found' }
    if (!guest.id_rejected_at || !guest.id_reject_reason) return { ok: false, error: 'nothing_to_resend' }
    const r = await sendIdRejectedDetailed(db, {
      accountId: args.accountId,
      stayId: stay.id,
      guestId: guest.id,
      reason: guest.id_reject_reason,
      requestUrl: args.requestUrl,
      transport: args.transport,
      notify: false,
    })
    return r.status === 'sent' ? { ok: true } : { ok: false, error: 'not_sent', reason: r.reason }
  }

  const key = args.target.messageKey as MessageKey
  if (!(MESSAGE_KEYS as readonly string[]).includes(key) || isStaffAlert(key)) return { ok: false, error: 'not_allowed' }

  const [{ data: property }, { data: override }] = await Promise.all([
    db.from('properties')
      .select('id, name, address, map_url, directions, review_url, access_instructions, caretaker_phone, default_checkin_time, default_checkout_time, deposit_refund_days')
      .eq('id', stay.property_id)
      .maybeSingle(),
    db.from('stay_message_templates')
      .select('body, meta_template_name')
      .eq('account_id', args.accountId)
      .eq('message_key', key)
      .maybeSingle(),
  ])
  const values = buildValues(stay, property ?? undefined, args.requestUrl)
  const text = renderTemplate(override?.body ?? DEFAULT_TEMPLATES[key], values)
  const template = override?.meta_template_name
    ? { name: override.meta_template_name as string, params: META_TEMPLATE_PARAMS[key].map((v) => values[v] ?? '') }
    : undefined

  const result = await sendStayWhatsApp(db, {
    accountId: args.accountId,
    stayId: stay.id,
    phone: stay.guest_phone,
    guestName: stay.guest_name,
    messageKey: key,
    text,
    template,
    enforceWindow: false,
    kind: 'reply',
    now,
    transport: args.transport,
  })
  if (result.outcome !== 'sent') {
    return { ok: false, error: 'not_sent', reason: result.reason ?? 'not_connected_or_paused' }
  }

  // If this message has a queue row, record the new send on it.
  await db
    .from('stay_messages')
    .update({ status: 'sent', sent_at: now.toISOString(), wa_message_id: result.messageId, last_error: null })
    .eq('stay_id', stay.id)
    .eq('message_key', key)
  return { ok: true }
}
