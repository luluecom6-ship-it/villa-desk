import type { SupabaseClient } from '@supabase/supabase-js'
import { handleStayInbound } from '@/lib/stays/messaging/inbound'
import { logStayMessage } from '@/lib/stays/messaging/send'
import { findRelayAgent, onAgentMessage } from '@/lib/stays/relay/server'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { hasMediaType, storeEvolutionMedia } from './media'
import { normalizeUpdates, normalizeUpsert, type NormalizedMessage } from './normalize'

// Evolution webhook deliveries -> the inbox, plus the stay logic.
//
//   guest message      stored in the inbox (channel = evolution), then
//                      handleStayInbound: READY / 1 / 2 for registered guests,
//                      alert for anything else, silence for unknown numbers
//                      while villa mode is on. Flows, automations and the AI bot
//                      do NOT run on this channel (the villa uses the stay logic).
//   typed on the phone stored as a staff message so the inbox shows the whole chat
//   receipts           delivered / read ticks on our messages

export interface ReceiveContext {
  db: SupabaseClient
  accountId: string
  requestUrl: string
}

const CONTENT_TYPE: Record<NormalizedMessage['type'], string> = {
  text: 'text', reply: 'text', image: 'image', video: 'video', document: 'document',
  audio: 'audio', sticker: 'image', location: 'text', reaction: 'text', contact: 'text', unknown: 'text',
}

function preview(n: NormalizedMessage): string {
  return n.text ?? `[${n.type}]`
}

type Stored = { url: string | null; mime: string | null }

async function mediaFor(ctx: ReceiveContext, n: NormalizedMessage): Promise<Stored> {
  if (!hasMediaType(n.type)) return { url: null, mime: null }
  return storeEvolutionMedia(ctx.db, supabaseAdmin().storage, ctx.accountId, n)
}

async function storeMessage(ctx: ReceiveContext, n: NormalizedMessage, conversationId: string, from: 'customer' | 'agent', media: Stored = { url: null, mime: null }): Promise<boolean> {
  const { data, error } = await ctx.db
    .from('messages')
    .upsert(
      {
        conversation_id: conversationId,
        sender_type: from,
        content_type: CONTENT_TYPE[n.type],
        content_text: n.text,
        media_url: media.url,
        media_type: media.mime,
        message_id: n.id,
        status: from === 'customer' ? 'delivered' : 'sent',
        created_at: new Date(Number(n.timestamp) * 1000).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[evolution] storing message failed:', error.code)
    return false
  }
  return !!data && data.length > 0 // false = a replay of a delivery we already have
}

async function receiveGuestMessage(ctx: ReceiveContext, n: NormalizedMessage): Promise<string> {
  const conv = await resolveConversationByPhone(ctx.db, ctx.accountId, `+${n.phone}`, n.pushName, { requireMetaConfig: false })
  const media = await mediaFor(ctx, n)
  const fresh = await storeMessage(ctx, n, conv.conversationId, 'customer', media)
  if (!fresh) return 'duplicate'
  await ctx.db.rpc('bump_conversation_on_inbound', { p_conversation_id: conv.conversationId, p_last_message_text: preview(n) })
  await ctx.db.from('conversations').update({ channel: 'evolution' }).eq('id', conv.conversationId)
  if (n.type === 'reaction') return 'reaction'

  try {
    const r = await handleStayInbound(ctx.db, {
      accountId: ctx.accountId,
      phone: n.phone,
      text: n.text ?? '',
      requestUrl: ctx.requestUrl,
      conversationId: conv.conversationId,
      guestName: n.pushName,
      messageId: n.id,
      mediaUrl: media.url,
      mediaType: media.mime,
      // Replies to a guest go back out on this same channel.
    })
    return r.handled ? 'stay_command' : r.registered ? 'registered_other' : r.suppressAutomation ? 'unregistered_silenced' : 'received'
  } catch (e) {
    console.error('[evolution] stay inbound failed:', (e as { code?: string })?.code ?? 'error')
    return 'stay_logic_error'
  }
}

async function recordPhoneMessage(ctx: ReceiveContext, n: NormalizedMessage): Promise<string> {
  if (n.type === 'reaction') return 'own_reaction_ignored'
  // Our own sends echo back here; give the sender a moment to store its row first.
  await new Promise((r) => setTimeout(r, 3000))
  const { data: existing } = await ctx.db.from('messages').select('id').eq('message_id', n.id).limit(1)
  if (existing && existing.length > 0) return 'own_send_echo'
  const conv = await resolveConversationByPhone(ctx.db, ctx.accountId, `+${n.phone}`, null, { requireMetaConfig: false })
  const fresh = await storeMessage(ctx, n, conv.conversationId, 'agent', await mediaFor(ctx, n))
  if (!fresh) return 'duplicate'
  const now = new Date().toISOString()
  await ctx.db
    .from('conversations')
    .update({ last_message_text: preview(n).slice(0, 200), last_message_at: now, updated_at: now, channel: 'evolution' })
    .eq('id', conv.conversationId)
  return 'phone_message_stored'
}

async function relayAgentMessage(ctx: ReceiveContext, agent: NonNullable<Awaited<ReturnType<typeof findRelayAgent>>>, n: NormalizedMessage): Promise<string> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || (() => { try { return new URL(ctx.requestUrl).origin } catch { return '' } })()
  const media = await mediaFor(ctx, n)
  return onAgentMessage(ctx.db, {
    accountId: ctx.accountId,
    agent,
    siteUrl,
    msg: { id: n.id, text: n.text, quotedId: n.quotedId, hasMedia: hasMediaType(n.type), mediaUrl: media.url, mediaType: media.mime },
  })
}

export async function receiveUpsert(data: unknown, ctx: ReceiveContext): Promise<string> {
  const items = Array.isArray(data) ? data : [data]
  const outcomes: string[] = []
  for (const item of items) {
    const n = normalizeUpsert(item)
    if (n.kind === 'ignore') {
      outcomes.push('ignored')
      continue
    }
    if (!n.phone) {
      outcomes.push('ignored_no_phone')
      continue
    }
    try {
      // Team members' numbers are never guest chats. Their messages to the villa number are
      // answers for a guest; what the villa number sent to them (the echo) is ignored.
      const agent = await findRelayAgent(ctx.db, ctx.accountId, n.phone)
      if (agent) {
        outcomes.push(n.fromMe ? 'staff_echo_ignored' : n.type === 'reaction' ? 'agent_reaction_ignored' : await relayAgentMessage(ctx, agent, n))
        continue
      }
      outcomes.push(n.fromMe ? await recordPhoneMessage(ctx, n) : await receiveGuestMessage(ctx, n))
    } catch (e) {
      console.error('[evolution] inbound failed:', (e as { code?: string })?.code ?? 'error')
      await logStayMessage(ctx.db, { accountId: ctx.accountId, stayId: null, messageKey: null, direction: 'in', outcome: 'inbound_ignored', reason: 'evolution_error', phone: n.phone })
      outcomes.push('error')
    }
  }
  return outcomes.join(',') || 'empty'
}

/** Delivered / read ticks on our own messages. */
export async function receiveUpdates(data: unknown, ctx: ReceiveContext): Promise<string> {
  const statuses = normalizeUpdates(data).filter((s) => s.fromMe && s.status !== 'sent')
  const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 0 }
  for (const s of statuses) {
    const { data: row } = await ctx.db.from('messages').select('id, status').eq('message_id', s.id).limit(1)
    const current = (row?.[0] as { id: string; status: string } | undefined)
    if (!current) continue
    if (s.status === 'failed' || (rank[s.status] ?? 0) > (rank[current.status] ?? 0)) {
      await ctx.db.from('messages').update({ status: s.status }).eq('id', current.id)
    }
  }
  return statuses.length ? `status:${statuses.length}` : 'no_status'
}
