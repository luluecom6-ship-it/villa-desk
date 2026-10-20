import type { SupabaseClient } from '@supabase/supabase-js'
import { findAutomationStay } from '../automation'
import { allAdultIdsVerified } from './conditions'
import { notifyStaff } from './notify'
import { openEscalation } from '../escalation/server'
import { logStayMessage, sendStayWhatsApp, type StayTransport } from './send'
import { DEFAULT_TEMPLATES, firstName, renderTemplate } from './templates'
import { buildValues } from './scheduler'
import { villaModeOn } from './villa-mode'
import { CARETAKER_REPLY, isGreeting, isMenuNumber, menuIsFresh, menuText, parseMenuChoice, type MenuChoice } from '../menu/logic'
import { stayFormUrl } from '../server'
import { FOOD_NOTE_THANKS, FOOD_NOT_READY, FOOD_RETRY, parseOrder } from '../food/logic'
import { loadMenu, placeOrder, sendFoodMenu } from '../food/server'

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
  if (t === 'ready') return 'ready'
  if (t === 'wifi' || t === 'access' || t === 'access details') return 'access'
  return 'other'
}

export interface StayInboundResult {
  /** The number is on the allow-list and the stay logic looked at the message. */
  registered: boolean
  /** The message was one of the stay commands (READY, 1, 2). */
  handled: boolean
  /** Villa mode is on and the number is NOT registered: block upstream bots. */
  suppressAutomation: boolean
  /** What happened to the copy for the agent's WhatsApp (event log): opened:sent, opened:no_number, follow:sent, no_number_set ... */
  escalation?: string
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
    /** A photo, voice note, video or file the guest sent (already stored). */
    mediaUrl?: string | null
    mediaType?: string | null
    now?: Date
    transport?: StayTransport
  },
): Promise<StayInboundResult> {
  const now = args.now ?? new Date()
  let escalation: string | undefined
  const report = (d: string) => { escalation = d }
  const stay = args.phone ? await findAutomationStay(db, args.accountId, args.phone, now) : null

  if (!stay) {
    // Not registered: the stay logic does nothing and sends nothing.
    const suppress = await villaModeOn(db, args.accountId)
    // Staff always see it: an unknown number writing to the villa is chased like any guest
    // message, whether or not villa mode is on.
    {
      if (args.conversationId) {
        await openEscalation(db, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          stayId: null,
          label: args.guestName ? args.guestName.split(/\s+/)[0] : 'an unknown number',
          preview: args.text,
          messageId: args.messageId,
          mediaUrl: args.mediaUrl,
          mediaType: args.mediaType,
          siteUrl: siteUrlOf(args.requestUrl),
          now,
          report,
        }).catch((e) => console.error('[escalation] open failed:', (e as { code?: string })?.code ?? 'error'))
      }
      if (suppress) {
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
    }
    return { registered: false, handled: false, suppressAutomation: suppress, escalation: escalation ?? 'no_active_stay_for_number' }
  }

  const { data: full } = await db
    .from('stays')
    .select('id, account_id, property_id, stay_ref, guest_name, guest_phone, status, form_status, form_token, checkin_at, checkout_at, created_at, on_the_way_at')
    .eq('id', stay.id)
    .maybeSingle()
  if (!full) return { registered: false, handled: false, suppressAutomation: true }

  const command = parseInboundCommand(args.text)
  const who = `${stay.stay_ref} (${firstName(full.guest_name)})`

  // ---- The guest's WhatsApp menu --------------------------------------------------------
  const reply = (text: string, key: string) =>
    sendStayWhatsApp(db, {
      accountId: args.accountId,
      stayId: stay.id,
      phone: full.guest_phone,
      guestName: full.guest_name,
      messageKey: key,
      text,
      enforceWindow: false,
      kind: 'reply',
      now,
      transport: args.transport,
    })
  const setMenu = async (state: 'main' | 'food' | null) => {
    if (!args.conversationId) return
    await db.from('conversations').update({ guest_menu_state: state, guest_menu_at: state ? now.toISOString() : null }).eq('id', args.conversationId)
  }
  let menuState: string | null = null
  let menuAt: string | null = null
  if (args.conversationId) {
    const { data: c } = await db.from('conversations').select('guest_menu_state, guest_menu_at').eq('id', args.conversationId).maybeSingle()
    menuState = (c?.guest_menu_state as string | null) ?? null
    menuAt = (c?.guest_menu_at as string | null) ?? null
  }
  const open = menuIsFresh(menuAt, now) ? menuState : null
  const handledMenu = { registered: true, handled: true, suppressAutomation: false } as const
  const logMenu = (key: string, reason?: string) =>
    logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: key, direction: 'in', outcome: 'inbound_handled', reason, phone: args.phone })

  const showMenu = async () => {
    const { data: prop } = await db.from('properties').select('name').eq('id', full.property_id).maybeSingle()
    const sent = await reply(menuText(firstName(full.guest_name), (prop?.name as string | undefined) ?? ''), 'menu')
    escalation = `menu_${sent.outcome}${'reason' in sent && sent.reason ? `:${sent.reason}` : ''}` // shown in the event log
    await setMenu('main')
    await logMenu('inbound_menu')
    return { ...handledMenu, escalation }
  }

  if (isGreeting(args.text)) return showMenu()

  if (open === 'food' && args.text.trim()) {
    // The guest is answering the food menu: item numbers make an order, anything else is a note for the caretaker.
    const stayRef = { id: stay.id, guest_phone: full.guest_phone, guest_name: full.guest_name }
    const { items } = await loadMenu(db, args.accountId)
    const parsed = items.length > 0 ? parseOrder(args.text, items) : ({ kind: 'text' } as const)
    if (parsed.kind === 'unknown_items') {
      await reply(`${FOOD_RETRY}\nThe menu has items 1 to ${items.length}.`, 'menu_food_retry')
      await setMenu('food') // keep waiting for a proper order
      return handledMenu
    }
    await setMenu(null)
    if (parsed.kind === 'order') {
      await placeOrder(db, { accountId: args.accountId, stay: stayRef, conversationId: args.conversationId, lines: parsed.lines, total: parsed.total, messageId: args.messageId, siteUrl: siteUrlOf(args.requestUrl), label: who, now, transport: args.transport, report })
      await logMenu('inbound_food_order')
      return { ...handledMenu, escalation }
    }
    if (args.conversationId) {
      await openEscalation(db, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        stayId: stay.id,
        label: who,
        preview: `🍽️ Food note: ${args.text.trim()}`,
        messageId: args.messageId,
        siteUrl: siteUrlOf(args.requestUrl),
        now,
        report,
      })
    } else {
      await notifyStaff(db, args.accountId, `Food note: ${who}`, args.text.trim().slice(0, 300), { includeCaretakers: true })
    }
    await reply(FOOD_NOTE_THANKS, 'menu_food_note')
    await logMenu('inbound_food_note')
    return { ...handledMenu, escalation }
  }

  let choice: MenuChoice | null = null
  if (open === 'main') choice = parseMenuChoice(args.text)
  else if (isMenuNumber(args.text)) return showMenu() // a bare number with no menu open: show the menu

  if (choice === 'form') {
    const { data: gs } = await db.from('stay_guests').select('is_adult, id_verified_at').eq('stay_id', stay.id)
    const adults = (gs ?? []).filter((g: { is_adult: boolean }) => g.is_adult)
    const approved = adults.filter((g: { id_verified_at: string | null }) => !!g.id_verified_at).length
    const status =
      full.form_status !== 'submitted'
        ? 'Your form has not been submitted yet.'
        : adults.length > 0 && approved === adults.length
          ? 'Your form is submitted and all IDs are approved ✅'
          : `Your form is submitted. IDs approved: ${approved} of ${adults.length}. If we asked you to upload an ID again, open the link and redo only that guest.`
    await reply(`${status}\n${stayFormUrl(args.requestUrl, full.form_token)}`, 'menu_form')
    await setMenu(null)
    await logMenu('inbound_form')
    return handledMenu
  }
  if (choice === 'caretaker') {
    await setMenu(null)
    if (args.conversationId) {
      await openEscalation(db, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        stayId: stay.id,
        label: who,
        preview: 'The guest asked to be connected with the caretaker.',
        messageId: args.messageId,
        siteUrl: siteUrlOf(args.requestUrl),
        now,
        report,
      })
    } else {
      await notifyStaff(db, args.accountId, `Guest wants the caretaker: ${who}`, 'Open the inbox to reply.', { includeCaretakers: true })
    }
    await reply(CARETAKER_REPLY, 'menu_caretaker')
    await logMenu('inbound_caretaker')
    return { ...handledMenu, escalation }
  }
  if (choice === 'food') {
    const shown = await sendFoodMenu(db, { accountId: args.accountId, stay: { id: stay.id, guest_phone: full.guest_phone, guest_name: full.guest_name }, now, transport: args.transport })
    if (shown) await setMenu('food')
    else {
      await reply(FOOD_NOT_READY, 'menu_food_none')
      await setMenu(null)
    }
    await logMenu('inbound_food_ask')
    return handledMenu
  }
  if (choice) await setMenu(null)

  if (command === 'ready' || choice === 'ready') {
    if (!full.on_the_way_at) {
      await db.from('stays').update({ on_the_way_at: now.toISOString() }).eq('id', stay.id)
    }
    await notifyStaff(db, args.accountId, `Guest on the way: ${who}`, 'The guest replied READY.', {
      includeCaretakers: true,
    })
    await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_ready', direction: 'in', outcome: 'inbound_handled', phone: args.phone })
    return { registered: true, handled: true, suppressAutomation: false }
  }

  if (command === 'access' || choice === 'access') {
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
      mediaUrl: args.mediaUrl,
      mediaType: args.mediaType,
      siteUrl: siteUrlOf(args.requestUrl),
      now,
      report,
    })
  } else {
    await notifyStaff(db, args.accountId, `Guest message: ${who}`, 'Open the inbox to read and reply.', { includeCaretakers: true })
  }
  await logStayMessage(db, { accountId: args.accountId, stayId: stay.id, messageKey: 'inbound_other', direction: 'in', outcome: 'inbound_handled', phone: args.phone })
  return { registered: true, handled: false, suppressAutomation: false, escalation }
}
