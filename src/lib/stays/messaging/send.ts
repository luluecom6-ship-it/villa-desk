import type { SupabaseClient } from '@supabase/supabase-js'
import { findAutomationStay } from '../automation'
import { inSendWindow } from './schedule'

// THE send function for automated stay messages (PDR 4.3).
//
// Every scheduled message and every automatic reply to a guest goes through
// sendStayWhatsApp(). It re-checks the allow-list at the moment of sending (not
// only when the message was queued) and refuses anything that is not a
// registered, active stay for that exact stay and number. A refused send is
// written to stay_message_log as blocked_not_registered and nothing is sent.
// Manual messages typed by staff in the inbox do not come through here.
//
// The transport is a plug: Meta today (via the existing send core), Evolution
// once it is ported. Nothing outside this file talks to WhatsApp for stays.

export interface StayTransportArgs {
  db: SupabaseClient
  accountId: string
  /** Digits with country code. */
  phone: string
  guestName: string
  text: string
  /** A picture to send with the text as its caption (Evolution only; Meta falls back to the text). */
  media?: { url: string; kind: 'image' }
  /** Approved Meta template to use instead of free text. */
  template?: { name: string; params: string[] }
  /**
   * 'scheduled' = we start the conversation, inside the sending hours;
   * 'immediate' = we start it but at once, at any hour (the first form link);
   * 'reply' = answering a guest who wrote first.
   */
  kind?: 'scheduled' | 'immediate' | 'reply'
}

/**
 * A transport throws this when the message cannot go right now for a reason
 * that is not a failure (number paused, outside its hours, daily limit,
 * not connected). The message stays queued and no attempt is used up.
 */
export class StayWaitError extends Error {
  constructor(readonly code: string) {
    super(`Not sent yet: ${code}`)
    this.name = 'StayWaitError'
  }
}

export type StayTransport = (args: StayTransportArgs) => Promise<{ messageId: string }>

export type SendOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'failed'; reason: string }
  /** Outside 09:00 to 20:00 IST: nothing was sent, try again later. */
  | { outcome: 'waiting'; reason?: string }

export interface SendStayArgs extends Omit<StayTransportArgs, 'db'> {
  stayId: string
  /** Message key for the log (a schedule key, or e.g. 'inbound_ready_ack'). */
  messageKey: string
  /** Scheduled sends honour the send window; replies to a guest do not. */
  enforceWindow: boolean
  now?: Date
  transport?: StayTransport
}

export const phoneTail = (phone: string): string => (phone ?? '').replace(/\D/g, '').slice(-4)

/** Only an error code or a short fixed word is ever stored, never message text. */
export function safeReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || 'send_error'
  }
  return 'send_error'
}

export async function logStayMessage(
  db: SupabaseClient,
  row: {
    accountId: string
    stayId: string | null
    messageKey: string | null
    direction?: 'out' | 'in'
    outcome:
      | 'sent'
      | 'failed'
      | 'blocked_not_registered'
      | 'skipped_condition'
      | 'cancelled'
      | 'inbound_handled'
      | 'inbound_ignored'
    reason?: string | null
    phone?: string | null
  },
): Promise<void> {
  const { error } = await db.from('stay_message_log').insert({
    account_id: row.accountId,
    stay_id: row.stayId,
    message_key: row.messageKey,
    direction: row.direction ?? 'out',
    outcome: row.outcome,
    reason: row.reason ?? null,
    phone_tail: row.phone ? phoneTail(row.phone) || null : null,
  })
  // The log is an audit aid; a failed write must not look like a failed send.
  if (error) console.error('[stay-messages] log write failed:', error.code)
}

export async function sendStayWhatsApp(
  db: SupabaseClient,
  args: SendStayArgs,
): Promise<SendOutcome> {
  const now = args.now ?? new Date()

  // The gate. Exact digits match, this stay, not past checkout + 7 days.
  const allowed = await findAutomationStay(db, args.accountId, args.phone, now)
  if (!allowed || allowed.id !== args.stayId) {
    await logStayMessage(db, {
      accountId: args.accountId,
      stayId: args.stayId,
      messageKey: args.messageKey,
      outcome: 'blocked_not_registered',
      reason: 'not_on_allow_list',
      phone: args.phone,
    })
    return { outcome: 'blocked', reason: 'not_on_allow_list' }
  }

  if (args.enforceWindow && !inSendWindow(now)) return { outcome: 'waiting' }

  try {
    const transport =
      args.transport ?? (await (await import('./channel')).defaultStayTransport(db, args.accountId, args.phone))
    const { messageId } = await transport({ ...args, db, kind: args.kind ?? (args.enforceWindow ? 'scheduled' : 'reply') })
    await logStayMessage(db, {
      accountId: args.accountId,
      stayId: args.stayId,
      messageKey: args.messageKey,
      outcome: 'sent',
      phone: args.phone,
    })
    return { outcome: 'sent', messageId }
  } catch (err) {
    if (err instanceof StayWaitError) return { outcome: 'waiting', reason: err.code }
    const reason = safeReason(err)
    await logStayMessage(db, {
      accountId: args.accountId,
      stayId: args.stayId,
      messageKey: args.messageKey,
      outcome: 'failed',
      reason,
      phone: args.phone,
    })
    return { outcome: 'failed', reason }
  }
}

/**
 * Meta Cloud API transport, through the app's existing send core so contacts,
 * conversations and the inbox stay consistent. Which channel a stay message
 * uses is decided in ./channel (the guest's last channel, else
 * `properties.default_channel`).
 */
export const metaTransport: StayTransport = async ({ db, accountId, phone, guestName, text, template }) => {
  // Imported here so the pure parts of this module stay cheap to test.
  const { resolveConversationByPhone } = await import('@/lib/whatsapp/resolve-conversation')
  const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message')

  const conv = await resolveConversationByPhone(db, accountId, `+${phone}`, guestName)
  const result = template
    ? await sendMessageToConversation(db, accountId, {
        conversationId: conv.conversationId,
        messageType: 'template',
        templateName: template.name,
        templateParams: template.params,
      })
    : await sendMessageToConversation(db, accountId, {
        conversationId: conv.conversationId,
        messageType: 'text',
        contentText: text,
      })
  return { messageId: result.whatsappMessageId }
}
