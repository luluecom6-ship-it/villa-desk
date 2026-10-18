import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { StayWaitError, type StayTransport } from '@/lib/stays/messaging/send'
import { EvolutionError, connectionState, sendAudio, sendMedia, sendText } from './client'
import { checkHealth, pauseNumber, recordSend, sendGate } from './safety-server'
import { connFromRow, loadEvolutionConfig } from './server'

// Stay messages through the WhatsApp app number (Evolution, Baileys).
// Free text only: no templates, no 24-hour window. Scheduled messages (we
// start the conversation) follow the safety rules; replies to a guest who
// wrote first do not count against the daily limit.

export class EvolutionSendError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'EvolutionSendError'
  }
}

const WAIT_CODES = new Set(['paused', 'outside_hours', 'daily_limit', 'disconnected'])

/** A 400 from Evolution says why in its body; turn the common reasons into a short readable code (no numbers in it). */
export function evolutionErrorCode(e: unknown): string {
  const status = e instanceof EvolutionError ? e.status : 0
  if (!status) return 'evolution_unreachable'
  if (status === 400 && e instanceof EvolutionError) {
    const raw = JSON.stringify(e.body ?? e.message ?? '')
    if (/"exists"\s*:\s*false/.test(raw)) return 'evolution_400_number_not_on_whatsapp'
    const msg = /"message"\s*:\s*\[?\s*"([^"]{3,80})"/.exec(raw)?.[1]
    if (msg) return `evolution_400_${msg.replace(/\d+/g, '').replace(/[^A-Za-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)}`
  }
  return `evolution_${status}`
}

export const evolutionStayTransport: StayTransport = async ({ db, accountId, phone, guestName, text, kind }) => {
  // 'immediate' (first form link) is business-initiated like 'scheduled': it counts toward the daily
  // limit but ignores the sending hours.
  const sendKind = kind === 'scheduled' || kind === 'immediate' ? 'scheduled' : 'reply'
  let cfg = await loadEvolutionConfig(accountId, db)
  if (!cfg) throw new EvolutionSendError('evolution_not_configured')

  // The stored state can be stale (a missed webhook leaves it on "connecting" or "close"): ask the
  // Evolution server before holding the message back.
  if (cfg.state !== 'open' && cfg.state !== 'logged_out' && !cfg.paused_at) {
    const live = await connectionState(connFromRow(cfg)).catch(() => 'unknown' as const)
    if (live === 'open') {
      await db.from('evolution_config').update({ state: 'open' }).eq('account_id', accountId)
      cfg = { ...cfg, state: 'open' }
    }
  }

  const gate = await sendGate(accountId, sendKind, { db, cfg, ignoreHours: kind === 'immediate' })
  if (gate) {
    if (WAIT_CODES.has(gate.code)) throw new StayWaitError(gate.code)
    throw new EvolutionSendError(`evolution_${gate.code}`)
  }

  const conn = connFromRow(cfg)
  const conv = await resolveConversationByPhone(db, accountId, `+${phone}`, guestName, { requireMetaConfig: false })
  try {
    const delayMs = sendKind === 'scheduled' ? 1500 + Math.floor(Math.random() * 2500) : undefined
    const { id } = await sendText(conn, phone, text, { delayMs })
    const messageId = id ?? `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await recordSend(accountId, { ok: true, kind: sendKind, phone }, db)

    const now = new Date().toISOString()
    const { error } = await db.from('messages').insert({
      conversation_id: conv.conversationId,
      // Automatic: stored as the bot so it never counts as a person replying to the guest.
      sender_type: 'bot',
      content_type: 'text',
      content_text: text,
      message_id: messageId,
      status: 'sent',
    })
    if (error) console.error('[evolution] storing sent message failed:', error.code)
    await db
      .from('conversations')
      .update({ last_message_text: text.slice(0, 200), last_message_at: now, updated_at: now, channel: 'evolution' })
      .eq('id', conv.conversationId)
    return { messageId }
  } catch (e) {
    const status = e instanceof EvolutionError ? e.status : 0
    const code = evolutionErrorCode(e)
    await recordSend(accountId, { ok: false, kind: sendKind, phone, errorCode: code }, db)
    // 401 = logged out, 403 = refused by WhatsApp: stop at once.
    if (status === 401 || status === 403) await pauseNumber(accountId, status === 401 ? 'logged_out' : 'refused_by_whatsapp', db).catch(() => undefined)
    else await checkHealth(accountId, db).catch(() => undefined)
    throw new EvolutionSendError(code)
  }
}

/**
 * A message typed by staff in the inbox, for a chat on the WhatsApp app number.
 * Manual messages are not subject to the guest gate or the daily limit, but the
 * number must be connected and not paused. Returns the WhatsApp message id; the
 * caller (sendMessageToConversation) stores the row.
 */
export async function sendStaffViaEvolution(
  db: SupabaseClient,
  accountId: string,
  m: { phone: string; messageType: string; text: string | null; mediaUrl: string | null; filename: string | null },
): Promise<string> {
  const cfg = await loadEvolutionConfig(accountId, db)
  const gate = await sendGate(accountId, 'reply', { db, cfg })
  if (gate) throw new EvolutionSendError(`evolution_${gate.code}`)
  const conn = connFromRow(cfg!)
  try {
    let id: string | null
    if (m.mediaUrl && (m.messageType === 'image' || m.messageType === 'video' || m.messageType === 'document')) {
      id = (await sendMedia(conn, m.phone, { kind: m.messageType, url: m.mediaUrl, caption: m.text ?? undefined, fileName: m.filename ?? undefined })).id
    } else if (m.mediaUrl && m.messageType === 'audio') {
      id = (await sendAudio(conn, m.phone, m.mediaUrl)).id
    } else {
      if (!m.text) throw new EvolutionSendError('evolution_no_text')
      id = (await sendText(conn, m.phone, m.text)).id
    }
    await recordSend(accountId, { ok: true, kind: 'reply', phone: m.phone }, db)
    return id ?? `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  } catch (e) {
    if (e instanceof EvolutionSendError) throw e
    const status = e instanceof EvolutionError ? e.status : 0
    const code = evolutionErrorCode(e)
    await recordSend(accountId, { ok: false, kind: 'reply', phone: m.phone, errorCode: code }, db)
    if (status === 401 || status === 403) await pauseNumber(accountId, status === 401 ? 'logged_out' : 'refused_by_whatsapp', db).catch(() => undefined)
    throw new EvolutionSendError(code)
  }
}
