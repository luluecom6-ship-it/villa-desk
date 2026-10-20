import type { SupabaseClient } from '@supabase/supabase-js'
import { sendStayWhatsApp, type StayTransport } from './send'
import { firstName } from './templates'

// When a guest submits (or re-submits) the form, the villa number tells them it arrived and
// is waiting for review. Sent at once, any hour (it answers something the guest just did).
// Best effort: a failure never affects the submit. No ID details are in the text.

export function formReceivedText(args: { firstName: string; propertyName?: string }): string {
  return (
    `Hi ${args.firstName}, thank you! We have received your form and ID details.\n\n` +
    `They are now pending review by our team. We will message you here once they are approved, ` +
    `or if anything needs to be corrected.\n\n` +
    `${args.propertyName ?? 'Mahinoor Stays'}`
  )
}

export async function sendFormReceivedMessage(
  db: SupabaseClient,
  args: { accountId: string; stayId: string; transport?: StayTransport },
): Promise<'sent' | 'not_sent'> {
  const { data: stay } = await db
    .from('stays')
    .select('id, guest_name, guest_phone, property_id')
    .eq('id', args.stayId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (!stay?.guest_phone) return 'not_sent'
  const { data: prop } = await db.from('properties').select('name').eq('id', stay.property_id).maybeSingle()

  const result = await sendStayWhatsApp(db, {
    accountId: args.accountId,
    stayId: stay.id,
    phone: stay.guest_phone,
    guestName: stay.guest_name,
    messageKey: 'form_received',
    text: formReceivedText({ firstName: firstName(stay.guest_name), propertyName: prop?.name }),
    enforceWindow: false,
    transport: args.transport,
  })
  return result.outcome === 'sent' ? 'sent' : 'not_sent'
}
