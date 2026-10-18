import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyStaff } from './notify'
import { sendStayWhatsApp, type StayTransport } from './send'
import { firstName } from './templates'
import { stayFormUrl } from '../server'

// When staff reject a guest's ID the guest is told straight away, with the
// reason and the link to upload it again (PDR 6.5). Not held to the 09:00 to
// 20:00 window: it answers something the guest just did. If it cannot be sent
// (number paused, disconnected, or any failure) the team is alerted so they can
// message the guest by hand. The reason is staff's own words and goes only to
// the guest; it is never written to the logs.

export function idRejectedText(args: { firstName: string; guestName: string; reason: string; formUrl: string; propertyName?: string }): string {
  const who = args.guestName ? ` for ${args.guestName}` : ''
  return (
    `Hi ${args.firstName}, we could not accept the ID${who}.\n\n` +
    `Reason: ${args.reason}\n\n` +
    `Please upload a clear photo again here: ${args.formUrl}\n\n` +
    `${args.propertyName ?? 'Mahinoor Stays'}`
  )
}

export type IdRejectedResult = { status: 'sent' } | { status: 'not_sent'; reason: string }

export async function sendIdRejectedMessage(
  db: SupabaseClient,
  args: { accountId: string; stayId: string; guestId: string; reason: string; requestUrl: string; transport?: StayTransport },
): Promise<'sent' | 'not_sent'> {
  return (await sendIdRejectedDetailed(db, args)).status
}

/** Same send, but says why it did not go out. `notify: false` for a manual resend (staff are looking at it). */
export async function sendIdRejectedDetailed(
  db: SupabaseClient,
  args: { accountId: string; stayId: string; guestId: string; reason: string; requestUrl: string; transport?: StayTransport; notify?: boolean },
): Promise<IdRejectedResult> {
  const { data: stay } = await db
    .from('stays')
    .select('id, stay_ref, guest_name, guest_phone, form_token, property_id')
    .eq('id', args.stayId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!stay?.guest_phone) return { status: 'not_sent', reason: 'no_mobile' }

  const { data: guest } = await db.from('stay_guests').select('full_name').eq('id', args.guestId).maybeSingle()
  const { data: prop } = await db.from('properties').select('name').eq('id', stay.property_id).maybeSingle()

  const text = idRejectedText({
    firstName: firstName(stay.guest_name),
    guestName: guest?.full_name && guest.full_name !== stay.guest_name ? guest.full_name : '',
    reason: args.reason,
    formUrl: stayFormUrl(args.requestUrl, stay.form_token),
    propertyName: prop?.name,
  })

  const result = await sendStayWhatsApp(db, {
    accountId: args.accountId,
    stayId: stay.id,
    phone: stay.guest_phone,
    guestName: stay.guest_name,
    messageKey: 'id_rejected',
    text,
    enforceWindow: false,
    transport: args.transport,
  })
  if (result.outcome === 'sent') return { status: 'sent' }
  const why = result.outcome === 'blocked' ? result.reason : result.outcome === 'failed' ? result.reason : 'not_connected_or_paused'
  if (args.notify === false) return { status: 'not_sent', reason: why }

  await notifyStaff(
    db,
    args.accountId,
    `ID rejected, guest not messaged: ${stay.stay_ref}`,
    'The WhatsApp message to the guest could not be sent. Please message the guest and ask them to upload the ID again.',
    { includeCaretakers: true },
  ).catch(() => undefined)
  return { status: 'not_sent', reason: why }
}
