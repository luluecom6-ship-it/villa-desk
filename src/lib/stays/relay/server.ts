/* eslint-disable @typescript-eslint/no-explicit-any -- rows from untyped supabase selects */
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectionState, sendAudio, sendMedia, sendReaction, sendText, userJid } from '@/lib/evolution/client'
import { kindForMime } from '@/lib/evolution/media'
import { evolutionErrorCode } from '@/lib/evolution/transport'
import { recordSend, sendGate } from '@/lib/evolution/safety-server'
import { connFromRow, loadEvolutionConfig } from '@/lib/evolution/server'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { loadResponders } from '../escalation/server'
import { decideOrder } from '../food/server'
import type { Responder } from '../escalation/plan'
import { HELP_TEXT, forwardText, maskPhone, orderAnswerFromReply, parseAgentMessage, type GuestCard } from './logic'

// Agent relay, database + WhatsApp side. Rules live in ./logic.ts.
//
//   guest -> villa number -> forwardToResponder -> the agent's own WhatsApp
//   agent -> villa number -> onAgentMessage     -> reply to the guest (or a /command)
//
// Messages to agents go straight through Evolution (they are staff, not guests:
// no allow-list, no daily limit) and are never stored as guest chats. The reply
// is sent with the normal inbox send, so it is saved in the inbox as an agent
// message, which is what stops the escalation clock.

export interface RelayItem {
  messageId: string
  text: string | null
  /** A photo, voice note, video or file (a stored copy). */
  mediaUrl?: string | null
  mediaType?: string | null
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

async function connection(db: SupabaseClient, accountId: string): Promise<{ conn: ReturnType<typeof connFromRow> | null; error: string | null }> {
  let cfg = await loadEvolutionConfig(accountId, db)
  if (!cfg) {
    console.error('[relay] not sent to team: no WhatsApp link set up')
    return { conn: null, error: 'evolution_not_configured' }
  }
  // The saved state can be stale (a missed webhook leaves "connecting"): ask Evolution before giving up.
  if (cfg.state !== 'open' && (!cfg.paused_at || cfg.paused_reason === 'logged_out')) {
    const live = await connectionState(connFromRow(cfg)).catch(() => 'unknown' as const)
    if (live === 'open') {
      const resume = cfg.paused_reason === 'logged_out'
      await db.from('evolution_config').update({ state: 'open', ...(resume ? { paused_at: null, paused_reason: null } : {}) }).eq('account_id', accountId)
      cfg = { ...cfg, state: 'open', ...(resume ? { paused_at: null, paused_reason: null } : {}) }
    }
  }
  const gate = await sendGate(accountId, 'reply', { db, cfg })
  if (gate) {
    console.error('[relay] not sent to team:', gate.code)
    return { conn: null, error: `evolution_${gate.code}` }
  }
  return { conn: connFromRow(cfg), error: null }
}

const failCode = (e: unknown): string => {
  try {
    return evolutionErrorCode(e)
  } catch {
    return 'send_error'
  }
}

/** Send text to a team member's own WhatsApp. `id` is null if it could not be sent, with the reason in `error`. */
export async function tellEx(db: SupabaseClient, accountId: string, phone: string, text: string): Promise<{ id: string | null; error: string | null }> {
  try {
    const { conn, error } = await connection(db, accountId)
    if (!conn) return { id: null, error }
    const { id } = await sendText(conn, phone, text)
    await recordSend(accountId, { ok: true, kind: 'reply', phone }, db)
    return { id: id ?? `tell-${Date.now()}`, error: null }
  } catch (e) {
    console.error('[relay] could not message a team member:', failCode(e))
    return { id: null, error: failCode(e) }
  }
}

/** Send text to a team member's own WhatsApp. Returns the WhatsApp message id, or null if it could not be sent. */
export async function tell(db: SupabaseClient, accountId: string, phone: string, text: string): Promise<string | null> {
  return (await tellEx(db, accountId, phone, text)).id
}

/** Send a stored photo / video / file / voice note to a team member's WhatsApp, with the guest's context as the caption. */
export async function tellMediaEx(db: SupabaseClient, accountId: string, phone: string, media: { url: string; mime: string | null }, caption: string): Promise<{ id: string | null; error: string | null }> {
  try {
    const { conn, error } = await connection(db, accountId)
    if (!conn) return { id: null, error }
    const kind = kindForMime(media.mime)
    let id: string | null
    if (kind === 'audio') {
      // A voice note has no caption: the context goes first as text, then the audio.
      id = (await sendText(conn, phone, caption)).id
      await sendAudio(conn, phone, media.url).catch(() => undefined)
    } else {
      id = (await sendMedia(conn, phone, { kind, url: media.url, caption })).id
    }
    await recordSend(accountId, { ok: true, kind: 'reply', phone }, db)
    return { id: id ?? `tell-${Date.now()}`, error: null }
  } catch (e) {
    console.error('[relay] could not send media to a team member:', failCode(e))
    return { id: null, error: failCode(e) }
  }
}

export async function tellMedia(db: SupabaseClient, accountId: string, phone: string, media: { url: string; mime: string | null }, caption: string): Promise<string | null> {
  return (await tellMediaEx(db, accountId, phone, media, caption)).id
}

const PLAIN: Record<string, string> = {
  evolution_400_number_not_on_whatsapp: 'that number is not on WhatsApp (check the country code in Settings → Profile → Guest messages)',
  evolution_not_configured: 'the villa WhatsApp number is not linked (Settings → WhatsApp link)',
  evolution_paused: 'sending is paused (Settings → WhatsApp link → Resume)',
  evolution_disconnected: 'the villa WhatsApp number is not connected (Settings → WhatsApp link)',
  evolution_unreachable: 'the Evolution server could not be reached',
}

/** Tell the owner/admins, in the app, that a team member could not be reached on WhatsApp (at most once per 30 minutes per person). */
async function reportUnreachable(db: SupabaseClient, accountId: string, who: Responder, error: string): Promise<void> {
  try {
    const title = `Could not WhatsApp ${who.name ?? 'a team member'}`
    const since = new Date(Date.now() - 30 * 60_000).toISOString()
    const { data: dup } = await db.from('notifications').select('id').eq('account_id', accountId).eq('title', title).gte('created_at', since).limit(1)
    if (dup && dup.length > 0) return
    const { data: admins } = await db.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin'])
    const reason = PLAIN[error] ?? `WhatsApp error ${error}`
    const rows = (admins ?? []).map((a: any) => ({ account_id: accountId, user_id: a.user_id, type: 'stay_alert', created_at: new Date().toISOString(), title, body: `A guest message was not copied to their WhatsApp: ${reason}.`.slice(0, 300) }))
    if (rows.length > 0) await db.from('notifications').insert(rows)
  } catch {
    /* best effort */
  }
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })

/** The guest as the agent sees them: name, masked number, and their stay if they have one. */
export async function guestCard(db: SupabaseClient, accountId: string, conversationId: string): Promise<{ card: GuestCard; code: number; stayId: string | null }> {
  const { data: conv } = await db
    .from('conversations')
    .select('relay_code, contact:contacts(name, phone)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  const contact = (conv as any)?.contact
  const digits = String(contact?.phone ?? '').replace(/\D/g, '')
  const card: GuestCard = { name: contact?.name && !/^\+?\d+$/.test(contact.name) ? String(contact.name) : null, phoneDigits: digits }
  let stayId: string | null = null
  if (digits) {
    const { data: stays } = await db.from('stays').select('id, stay_ref, guest_name, checkin_at, checkout_at, created_at').eq('account_id', accountId).eq('guest_phone', digits)
    const stay = [...(stays ?? [])].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    if (stay) {
      stayId = stay.id
      card.name = card.name ?? String(stay.guest_name ?? '') ?? null
      card.stayRef = stay.stay_ref
      card.stayDates = stay.checkin_at && stay.checkout_at ? `${fmtDay(stay.checkin_at)} to ${fmtDay(stay.checkout_at)}` : null
    }
  }
  return { card, code: Number((conv as any)?.relay_code ?? 0), stayId }
}

/** The last few messages before these ones, so the agent has the context without opening the app. */
async function recentHistory(db: SupabaseClient, conversationId: string, skipIds: string[], limit = 4): Promise<string[]> {
  const { data } = await db
    .from('messages')
    .select('message_id, sender_type, content_text, media_type, created_at')
    .eq('conversation_id', conversationId)
  return [...(data ?? [])]
    .filter((m: any) => !skipIds.includes(String(m.message_id)))
    .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit)
    .map((m: any) => {
      const text = (m.content_text as string | null)?.trim() || (m.media_type ? `[${kindForMime(m.media_type)}]` : '')
      return text ? `${m.sender_type === 'customer' ? 'Guest' : 'Us'}: ${clip(text.replace(/\s+/g, ' '), 160)}` : ''
    })
    .filter(Boolean)
}

/**
 * Copy guest messages to one team member's WhatsApp and remember each copy so a
 * swipe-reply finds its guest. A message already sent to this person is skipped.
 */
export async function forwardToResponder(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; to: Responder; items: RelayItem[]; intro: boolean; movedFrom?: string | null },
): Promise<number> {
  if (!args.to.alertPhone || args.items.length === 0) return 0
  const { card, code } = await guestCard(db, args.accountId, args.conversationId)
  const history = args.intro ? await recentHistory(db, args.conversationId, args.items.map((i) => i.messageId)).catch(() => []) : []
  let sent = 0
  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]
    const { data: dup } = await db
      .from('relay_forwards')
      .select('id')
      .eq('conversation_id', args.conversationId)
      .eq('user_id', args.to.userId)
      .eq('source_message_id', item.messageId)
      .limit(1)
    if (dup && dup.length > 0) continue
    const label = item.mediaType ? `[${kindForMime(item.mediaType)}]` : null
    const body = [label, item.text ? clip(item.text, 1500) : null].filter(Boolean).join(' ') || null
    const text = forwardText({ code, card, body, intro: args.intro && i === 0, movedFrom: i === 0 ? args.movedFrom : null, history: i === 0 ? history : [] })
    const { id, error } = item.mediaUrl
      ? await tellMediaEx(db, args.accountId, args.to.alertPhone, { url: item.mediaUrl, mime: item.mediaType ?? null }, text)
      : await tellEx(db, args.accountId, args.to.alertPhone, text)
    if (!id) {
      if (error) await reportUnreachable(db, args.accountId, args.to, error)
      continue
    }
    sent++
    await db.from('relay_forwards').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      user_id: args.to.userId,
      forward_message_id: id,
      source_message_id: item.messageId,
    })
  }
  return sent
}

/** The guest messages nobody has answered yet (since `since`), oldest first. */
export async function unansweredGuestMessages(db: SupabaseClient, conversationId: string, since: string, limit = 5): Promise<RelayItem[]> {
  const { data } = await db
    .from('messages')
    .select('message_id, content_text, media_url, media_type, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gte('created_at', since)
  return [...(data ?? [])]
    .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit)
    .map((m: any) => ({ messageId: String(m.message_id), text: (m.content_text as string | null) ?? null, mediaUrl: (m.media_url as string | null) ?? null, mediaType: (m.media_type as string | null) ?? null }))
}

/** The team member registered under this WhatsApp number, if any. Staff numbers never become guest chats. */
export async function findRelayAgent(db: SupabaseClient, accountId: string, phoneDigits: string): Promise<Responder | null> {
  const people = await loadResponders(db, accountId)
  return people.find((p) => p.alertPhone === phoneDigits && ['owner', 'admin', 'agent'].includes(p.role)) ?? null
}

export interface AgentMessage {
  id: string
  text: string | null
  quotedId: string | null
  /** The agent sent a photo, voice note, video or file. */
  hasMedia: boolean
  /** Its stored copy (null if it could not be downloaded). */
  mediaUrl?: string | null
  mediaType?: string | null
}

async function openEscalationsOf(db: SupabaseClient, accountId: string, userId: string) {
  const { data } = await db.from('conversation_escalations').select('id, conversation_id, notified_user_ids, opened_at, due_at').eq('account_id', accountId).eq('status', 'open')
  return (data ?? []).filter((e: any) => (e.notified_user_ids ?? []).at(-1) === userId)
}

/** Which guest is this message for: a swipe-reply, a #number, or the agent's only open chat. */
async function targetConversation(db: SupabaseClient, accountId: string, agent: Responder, msg: AgentMessage, code: number | null): Promise<string | null> {
  if (msg.quotedId) {
    const { data } = await db.from('relay_forwards').select('conversation_id').eq('account_id', accountId).eq('forward_message_id', msg.quotedId).limit(1)
    if (data?.[0]) return data[0].conversation_id as string
  }
  if (code) {
    const { data } = await db.from('conversations').select('id').eq('account_id', accountId).eq('relay_code', code).limit(1)
    if (data?.[0]) return data[0].id as string
  }
  const mine = await openEscalationsOf(db, accountId, agent.userId)
  if (mine.length === 1) return mine[0].conversation_id as string
  if (mine.length === 0) {
    // Nothing open: the chat the agent was last sent, if it is clear.
    const { data } = await db.from('relay_forwards').select('conversation_id, created_at').eq('account_id', accountId).eq('user_id', agent.userId).gte('created_at', new Date(Date.now() - 24 * 3_600_000).toISOString())
    const ids = [...new Set((data ?? []).map((r: any) => r.conversation_id as string))]
    if (ids.length === 1) return ids[0]
  }
  return null
}

async function listText(db: SupabaseClient, accountId: string, agent: Responder): Promise<string> {
  const mine = await openEscalationsOf(db, accountId, agent.userId)
  if (mine.length === 0) return 'You have no open chats.'
  const lines: string[] = []
  for (const e of mine) {
    const { card, code } = await guestCard(db, accountId, e.conversation_id)
    const mins = Math.max(1, Math.round((Date.now() - new Date(e.opened_at).getTime()) / 60_000))
    lines.push(`#${code} ${card.name ?? maskPhone(card.phoneDigits)}, waiting ${mins} min`)
  }
  return `*Your open chats*\n${lines.join('\n')}`
}

/** An agent wrote to the villa number: a reply for a guest, or a /command. Returns what happened (for the event log). */
export async function onAgentMessage(
  db: SupabaseClient,
  args: { accountId: string; agent: Responder; msg: AgentMessage; siteUrl: string; now?: Date },
): Promise<string> {
  const { accountId, agent, msg } = args
  const phone = agent.alertPhone as string
  let cmd = parseAgentMessage(msg.text)
  const react = async (emoji: string) => {
    try {
      const { conn } = await connection(db, accountId)
      if (conn) await sendReaction(conn, { remoteJid: userJid(phone), fromMe: false, id: msg.id }, emoji)
    } catch {
      /* a reaction is a courtesy */
    }
  }

  if (cmd.kind === 'on' || cmd.kind === 'off') {
    await db.from('profiles').update({ available: cmd.kind === 'on' }).eq('user_id', agent.userId).eq('account_id', accountId)
    await tell(db, accountId, phone, cmd.kind === 'on' ? '✅ You are on duty. New guest messages will come to you.' : '⏸️ You are off duty. New guest messages skip you.')
    return `agent_${cmd.kind}`
  }
  if (cmd.kind === 'help') {
    await tell(db, accountId, phone, HELP_TEXT)
    return 'agent_help'
  }
  if (cmd.kind === 'list') {
    await tell(db, accountId, phone, await listText(db, accountId, agent))
    return 'agent_list'
  }

  const conversationId = await targetConversation(db, accountId, agent, msg, cmd.code)
  if (!conversationId) {
    await tell(db, accountId, phone, `⚠️ Not sent. Which guest is this for? Swipe-reply to their message, or start with their number (e.g. #482).\n\n${await listText(db, accountId, agent)}`)
    return 'agent_no_target'
  }
  // "ok" / "no" swiped onto a guest who has a food order waiting answers that order (it is not a message for the guest).
  if (cmd.kind === 'reply' && !msg.hasMedia) {
    const answer = orderAnswerFromReply(cmd.text)
    if (answer) {
      const { data: waiting } = await db.from('food_orders').select('id').eq('account_id', accountId).eq('conversation_id', conversationId).eq('status', 'pending').limit(1)
      if (waiting && waiting.length > 0) cmd = answer.kind === 'approve' ? { kind: 'approve', code: null } : { kind: 'decline', reason: answer.reason, code: null }
    }
  }
  const { card, code, stayId } = await guestCard(db, accountId, conversationId)
  const label = `#${code} ${card.name ?? maskPhone(card.phoneDigits)}`

  if (cmd.kind === 'close') {
    await db
      .from('conversation_escalations')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_reason: 'replied' })
      .eq('conversation_id', conversationId)
      .eq('status', 'open')
    await tell(db, accountId, phone, `✅ ${label} closed.`)
    return 'agent_close'
  }

  if (cmd.kind === 'info') {
    const { data: recent } = await db.from('messages').select('sender_type, content_text, created_at').eq('conversation_id', conversationId)
    const last = [...(recent ?? [])]
      .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-4)
      .map((r: any) => `${r.sender_type === 'customer' ? '👤' : '🏠'} ${clip(String(r.content_text ?? '[media]'), 80)}`)
      .join('\n')
    const stay = [card.stayRef, card.stayDates].filter(Boolean).join(' · ')
    await tell(db, accountId, phone, [`*${label}* (${maskPhone(card.phoneDigits)})`, stay, '', last, args.siteUrl ? `\n${args.siteUrl}/inbox` : ''].filter((l) => l !== undefined && l !== null).join('\n').trim())
    return 'agent_info'
  }

  if (cmd.kind === 'approve' || cmd.kind === 'decline') {
    const r = await decideOrder(db, {
      accountId,
      conversationId,
      decision: cmd.kind === 'approve' ? 'confirmed' : 'declined',
      byUserId: agent.userId,
      byName: agent.name ?? null,
      reason: cmd.kind === 'decline' ? cmd.reason : null,
    })
    if (!r.ok) {
      await tell(db, accountId, phone, r.error === 'already_decided' ? `ℹ️ ${label}: that order was already answered.` : `ℹ️ ${label} has no food order waiting.`)
      return 'agent_order_none'
    }
    const told = r.guestMessage === 'sent' ? 'The guest has been told.' : '⚠️ The guest could not be messaged just now: tell them by hand.'
    await tell(db, accountId, phone, `${cmd.kind === 'approve' ? '✅' : '❌'} Order F${r.orderNo} ${cmd.kind === 'approve' ? 'confirmed' : 'declined'} for ${label}. ${told}`)
    return cmd.kind === 'approve' ? 'agent_order_confirmed' : 'agent_order_declined'
  }

  if (cmd.kind === 'transfer') {
    const want = cmd.to.trim().toLowerCase()
    const people = (await loadResponders(db, accountId)).filter((p) => p.userId !== agent.userId && p.alertPhone && ['owner', 'admin', 'agent'].includes(p.role))
    const target = want ? people.find((p) => (p.name ?? '').toLowerCase().startsWith(want)) : undefined
    if (!target) {
      await tell(db, accountId, phone, `⚠️ No one called “${cmd.to}”. Choose from: ${people.map((p) => p.name).filter(Boolean).join(', ') || 'nobody has a WhatsApp number set'}`)
      return 'agent_transfer_unknown'
    }
    const { data: esc } = await db.from('conversation_escalations').select('id, notified_user_ids, opened_at').eq('conversation_id', conversationId).eq('status', 'open').limit(1)
    const now = (args.now ?? new Date()).toISOString()
    let since = now
    if (esc?.[0]) {
      since = esc[0].opened_at
      await db.from('conversation_escalations').update({ notified_user_ids: [...(esc[0].notified_user_ids ?? []), target.userId], last_notified_at: now }).eq('id', esc[0].id)
    } else {
      since = new Date(Date.now() - 24 * 3_600_000).toISOString()
      await db.from('conversation_escalations').insert({ account_id: accountId, conversation_id: conversationId, stay_id: stayId, status: 'open', notified_user_ids: [agent.userId, target.userId], opened_at: now, last_notified_at: now, due_at: new Date(Date.now() + 10 * 60_000).toISOString() })
    }
    const items = await unansweredGuestMessages(db, conversationId, since)
    await forwardToResponder(db, { accountId, conversationId, to: target, items: items.length ? items : [{ messageId: `transfer-${conversationId}-${now}`, text: null }], intro: true, movedFrom: agent.name ?? null })
    await tell(db, accountId, phone, `✅ ${label} moved to ${target.name}.`)
    return 'agent_transfer'
  }

  // A reply for the guest: text, or a photo / voice note / video / file (stored copy), with the agent's caption.
  if (msg.hasMedia && !msg.mediaUrl) {
    await tell(db, accountId, phone, '⚠️ Not sent: that photo, voice note or file could not be downloaded. Please send it again.')
    return 'agent_media_failed'
  }
  if (!cmd.text && !msg.mediaUrl) return 'agent_empty'
  try {
    await sendMessageToConversation(db, accountId, msg.mediaUrl
      ? { conversationId, messageType: kindForMime(msg.mediaType), contentText: cmd.text || null, mediaUrl: msg.mediaUrl }
      : { conversationId, messageType: 'text', contentText: cmd.text })
  } catch (e) {
    await tell(db, accountId, phone, clip(`⚠️ Not delivered to ${label}: ${e instanceof Error ? e.message : String(e)}`, 500))
    return 'agent_reply_failed'
  }
  await react('✅')
  return 'agent_reply_sent'
}
