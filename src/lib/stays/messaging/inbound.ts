import type { SupabaseClient } from '@supabase/supabase-js'
import { findAutomationStay } from '../automation'
import { allAdultIdsVerified } from './conditions'
import { notifyStaff } from './notify'
import { openEscalation } from '../escalation/server'
import { logStayMessage, sendStayWhatsApp, type StayTransport } from './send'
import { DEFAULT_TEMPLATES, firstName, renderTemplate } from './templates'
import { buildValues } from './scheduler'
import { villaModeOn } from './villa-mode'

// Replies from guests (PDR 7.2). Runs at the top of the inbound handler, and
// only does anything for numbers on the allow-list.
//
//   READY or 1   record "on the way", tell the team (caretaker included)
//   2            send the access instructions again (only once IDs are verified)
//   anything else  alert the team; no automatic answer from the stay logic

export type StayInboundCommand = 'ready' | 'access' | 'other'

function siteUrlOf(requestUrl: string): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (env) return env
  try {
    return new URL(requestUrl).origin
  } catch {
    return ''
  }
}

export function parseInboundCommand(text: string): StayInboundCommand {
  const t = (text ?? '').trim().toLowerCase().replace(/[.!\s]+$/g, '')
  if (t === 'ready' || t === '1') return 'ready'
  if (t === '2') return 'access'
  return 'other'
}

export interface StayInboundResult {
  /** The number is on the allow-list and the stay logic looked at the message. */
  registered: boolean
  /** The message was one of the stay commands (READY, 1, 2). */
  handled: boolean
  /** Villa mode is on and the number is NOT registered: block upstream bots. */
  suppressAutomation: boolean
}

export async function handleStayInbound(
  db: SupabaseClient,
  args: {
    accountId: string
    /** Sender's number, digits. Null for a sender known only by a username. */
    phone: string | null
    text: string
    requestUrl: string
    /** The guest's conversation. With it, a message that needs a person is chased (agent, next agent, owner). */
    conversationId?: string
    guestName?: string | null
    /** The guest's WhatsApp message id (so it is forwarded to the agent once). */
    messageId?: string
    now?: Date
    transport?: StayTransport
  },
): Promise<StayInboundResult> {
  const now = args.now ?? new Date()
  const stay = args.phone ? await findAutomationStay(db, args.accountId, args.phone, now) : null

  if (!stay) {
    // Not registered: the stay logic does nothing and sends nothing.
    const suppress = await villaModeOn(db, args.accountId)
    if (suppress) {
      // Staff still see it: an unknown number writing to the villa is chased like any guest message.
      if (args.conversationId) {
        await openEscalation(db, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          stayId: null,
          label: args.guestName ? args.guestName.split(/\s+/)[0] : 'an unknown number',
          preview: args.text,
          messageId: args.messageId,
          siteUrl: siteUrlOf(args.requestUrl),
          now,
        }).catch((e) => console.error('[escalation] open failed:', (e as { code?: string })?.code ?? 'error'))
      }
      await logStayMessage(db, {
        accountId: args.accountId,
        stayId: null,
        messageKey: null,
        direction: 'in',
        outcome: 'inbound_ignored',
        reason: 'not_on_allow_list',
        phone: args.phone,
      })
    }
    return { registered: false, handled: false, suppressAutomation: suppress }
  }

  const { data: full } = await db
    .from('stays')
    .select('id, account_id, property_id, stay_ref, guest_name, guest_phone, status, form_status, form_token, checkin_at, checkout_at, created_at, on_the_way_at')
    .eq('id', stay.id)
    .maybeSingle()
  if (!full) return { registered: false, handled: false, suppressAutomation: true }

  const command = parseInboundCommand(args.text)
  const who = `${stay.stay_ref} (${firstName(full.guest_name)})`

  if (command === 'ready') {
    if (!full.on_the_way_at) {
      await db.from('stays').update({ on_the_way_at: now.toISOString() }).eq('id', stay.id)
    }
    await notifyStaff(db, args.accountId, `Guest on the way: ${who}`, 'The guest replied READY.', {
      includeCaretakers: true,
    })
    await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_ready', direction: 'in', outcome: 'inbound_handled', phone: args.phone })
    return { registered: true, handled: true, suppressAutomation: false }
  }

  if (command === 'access') {
    const { data: guests } = await db.from('stay_guests').select('is_adult, id_verified_at').eq('stay_id', stay.id)
    if (!allAdultIdsVerified(guests ?? [])) {
      await notifyStaff(db, args.accountId, `Guest asked for access details: ${who}`, 'IDs are not all verified yet, so nothing was sent. Verify the IDs or reply by hand.', { includeCaretakers: true })
      await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_access', direction: 'in', outcome: 'inbound_handled', reason: 'ids_not_verified', phone: args.phone })
      return { registered: true, handled: true, suppressAutomation: false }
    }
    const [{ data: property }, { data: override }] = await Promise.all([
      db.from('properties').select('id, name, address, map_url, directions, review_url, access_instructions, caretaker_phone, default_checkin_time, default_checkout_time, deposit_refund_days').eq('id', full.property_id).maybeSingle(),
      db.from('stay_message_templates').select('body').eq('account_id', args.accountId).eq('message_key', 'access_details').maybeSingle(),
    ])
    const text = renderTemplate(override?.body ?? DEFAULT_TEMPLATES.access_details, buildValues(full, property ?? undefined, args.requestUrl))
    const sent = await sendStayWhatsApp(db, {
      accountId: args.accountId,
      stayId: stay.id,
      phone: full.guest_phone,
      guestName: full.guest_name,
      messageKey: 'inbound_access_resend',
      text,
      enforceWindow: false, // a reply to the guest, not a scheduled send
      now,
      transport: args.transport,
    })
    if (sent.outcome === 'failed') {
      await notifyStaff(db, args.accountId, `Could not resend access details: ${who}`, 'Please send them by hand.', { includeCaretakers: true })
    }
    await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_access', direction: 'in', outcome: 'inbound_handled', phone: args.phone })
    return { registered: true, handled: true, suppressAutomation: false }
  }

  // Help, or anything else: a person should read it. The conversation already
  // exists in the inbox; the team gets an alert and no automatic answer is sent.
  // The agent is told first; if nobody replies it moves to the next agent, then the owner.
  if (args.conversationId) {
    await openEscalation(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      stayId: stay.id,
      label: who,
      preview: args.text,
      messageId: args.messageId,
      siteUrl: siteUrlOf(args.requestUrl),
      now,
    })
  } else {
    await notifyStaff(db, args.accountId, `Guest message: ${who}`, 'Open the inbox to read and reply.', { includeCaretakers: true })
  }
  await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_other', direction: 'in', outcome: 'inbound_handled', phone: args.phone })
  return { registered: true, handled: false, suppressAutomation: false }
}
