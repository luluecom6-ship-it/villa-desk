import type { SupabaseClient } from '@supabase/supabase-js'
import { kickStayScheduler } from '../messaging/kick'
import { notifyStayCreated } from '../messaging/form-submitted'
import { parseCreateStay } from '../validate'
import { closeFinishedStays, isLivePhoneConflict, linkContact } from '../server'
import { parseRegisterMessage, REGISTER_TEMPLATE } from './logic'

export { REGISTER_TEMPLATE }

const IST = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })

/**
 * Create a stay from a filled-in WhatsApp form sent by a team member.
 * Same validation as POST /api/stays (parseCreateStay). Returns the reply text for the sender.
 * Never records deposits (those stay owner / admin in the app).
 */
export async function registerFromWhatsApp(
  db: SupabaseClient,
  args: { accountId: string; userId: string; text: string; siteUrl: string; now?: Date },
): Promise<{ reply: string; created: boolean }> {
  const parsed = parseRegisterMessage(args.text, args.now)
  if (!parsed.ok) {
    return { created: false, reply: ['⚠️ Not registered. Please fix:', ...parsed.problems.map((p) => `• ${p}`), '', 'Edit your message and send it again. (Send *Register New* for a fresh form.)'].join('\n') }
  }
  const valid = parseCreateStay(parsed.body)
  if (!valid.ok) {
    const bad = Object.keys(valid.errors)
    const names: Record<string, string> = { guest_phone: 'Mobile', guest_name: 'Name', checkin_at: 'Check-in', checkout_at: 'Check-out', guests_count: 'Guests', source: 'Source', guest_email: 'Email', external_booking_ref: 'Booking ref', notes: 'Notes' }
    return { created: false, reply: `⚠️ Not registered. Please check: ${bad.map((k) => names[k] ?? k).join(', ')}.\n\nEdit your message and send it again.` }
  }
  const input = valid.value

  try {
    const { data: props } = await db.from('properties').select('id').eq('account_id', args.accountId).order('created_at', { ascending: true }).limit(1)
    let propertyId = props?.[0]?.id as string | undefined
    if (!propertyId) {
      const { data: acc } = await db.from('accounts').select('name').eq('id', args.accountId).maybeSingle()
      const { data: p, error } = await db.from('properties').insert({ account_id: args.accountId, name: (acc as { name?: string } | null)?.name ?? 'Villa' }).select('id').single()
      if (error || !p) throw new Error('property')
      propertyId = p.id as string
    }
    const contactId = input.guest_phone ? await linkContact(db, { accountId: args.accountId, userId: args.userId }, input.guest_phone, input.guest_name) : null
    const insertStay = () =>
      db.from('stays').insert({ account_id: args.accountId, property_id: propertyId, contact_id: contactId, created_by: args.userId, ...input }).select('*').single()
    let { data, error } = await insertStay()
    if (isLivePhoneConflict(error) && input.guest_phone) {
      if ((await closeFinishedStays(db, args.accountId, input.guest_phone)) > 0) ({ data, error } = await insertStay())
    }
    if (isLivePhoneConflict(error)) {
      return { created: false, reply: '⚠️ Not registered: this mobile number already has a stay that is still active. Check the Stays page.' }
    }
    if (error || !data) return { created: false, reply: '⚠️ Not registered: something went wrong on our side. Please try again, or register it in the app.' }

    try {
      await notifyStayCreated(db, { accountId: args.accountId, stayRef: data.stay_ref, guestName: data.guest_name, checkin: data.checkin_at, formSent: !!data.guest_phone, createdBy: args.userId, siteUrl: args.siteUrl })
    } catch {
      /* the team alert is a courtesy */
    }
    if (data.guest_phone) await kickStayScheduler(args.siteUrl.replace(/\/+$/, '') + '/')

    return {
      created: true,
      reply: [
        `✅ Registered *${data.stay_ref}*`,
        `Guest: ${data.guest_name} (+${data.guest_phone})`,
        `Check-in: ${IST(data.checkin_at)}`,
        `Check-out: ${IST(data.checkout_at)}`,
        `Guests: ${data.guests_count} · Source: ${data.source}`,
        '',
        'The guest form link is being sent to the guest now.',
      ].join('\n'),
    }
  } catch (e) {
    console.error('[register] failed:', (e as Error)?.message)
    return { created: false, reply: '⚠️ Not registered: something went wrong on our side. Please try again, or register it in the app.' }
  }
}
