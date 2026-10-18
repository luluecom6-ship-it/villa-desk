/* eslint-disable @typescript-eslint/no-explicit-any -- rows from untyped supabase selects */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendText } from '@/lib/evolution/client'
import { recordSend, sendGate } from '@/lib/evolution/safety-server'
import { connFromRow, loadEvolutionConfig } from '@/lib/evolution/server'
import { buildChain, decide, nextResponder, type Responder } from './plan'
import { forwardToResponder, tell, unansweredGuestMessages, type RelayItem } from '../relay/server'

// Guest messages that need a person (PDR 7.2 "anything else", and any message
// from a number that is not registered while villa mode is on).
//   1. Tell the first available agent: bell in the app + a WhatsApp from the
//      villa number to their alert number (if they set one).
//   2. Nobody has replied after `escalate_after_minutes` -> the next agent.
//   3. No agent left -> the owner.
// "Replied" means a person sent a message in that conversation after the guest
// wrote (from the inbox, or typed on the villa phone). Automatic messages are
// stored as sender "bot" and do not count. The chase is run by the scheduler
// (cron every minute is best), so it keeps going with nobody in the app.

const DEFAULT_MINUTES = 10

export async function loadResponders(db: SupabaseClient, accountId: string): Promise<Responder[]> {
  const { data } = await db
    .from('profiles')
    .select('user_id, account_role, available, alert_phone, created_at, full_name')
    .eq('account_id', accountId)
  return (data ?? []).map((p: any) => ({
    userId: p.user_id,
    role: p.account_role,
    available: p.available !== false,
    alertPhone: p.alert_phone ?? null,
    createdAt: p.created_at ?? '',
    name: p.full_name ?? null,
  }))
}

async function escalateMinutes(db: SupabaseClient, accountId: string): Promise<number> {
  const { data } = await db.from('properties').select('escalate_after_minutes').eq('account_id', accountId).limit(1)
  const n = Number((data?.[0] as { escalate_after_minutes?: number } | undefined)?.escalate_after_minutes)
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MINUTES
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A WhatsApp from the villa number to a team member's own alert number. Best effort; never throws. */
export async function whatsappTeamAlert(db: SupabaseClient, accountId: string, phone: string, text: string): Promise<void> {
  await tell(db, accountId, phone, text)
}

/**
 * Bell in the app, and the guest's message copied to the person's own WhatsApp
 * (when they set a number) so they can swipe-reply from there.
 */
export async function alertResponder(
  db: SupabaseClient,
  accountId: string,
  to: Responder,
  info: { label: string; preview: string; siteUrl: string; escalated: boolean; conversationId?: string; items?: RelayItem[]; movedFrom?: string | null },
): Promise<void> {
  const title = `${info.escalated ? 'Not answered yet: ' : ''}Guest message: ${info.label}`
  await db
    .from('notifications')
    .insert({ account_id: accountId, user_id: to.userId, type: 'stay_alert', title: clip(title, 200), body: clip(info.preview || 'Photo, voice note or file. Open the inbox to see it.', 200) })
    .then(({ error }: { error: { code?: string } | null }) => {
      if (error) console.error('[escalation] bell failed:', error.code)
    })

  if (!to.alertPhone || !info.conversationId) return
  try {
    const items = info.items && info.items.length > 0 ? info.items : [{ messageId: `alert-${info.conversationId}-${Date.now()}`, text: info.preview }]
    const sent = await forwardToResponder(db, { accountId, conversationId: info.conversationId, to, items, intro: true, movedFrom: info.movedFrom })
    if (sent === 0 && !info.items) await tell(db, accountId, to.alertPhone, `Guest message from ${info.label}. Please reply in the app: ${info.siteUrl}/inbox`)
  } catch (e) {
    console.error('[escalation] whatsapp forward failed:', (e as { status?: number })?.status ?? 'error')
  }
}

export async function openEscalation(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; stayId: string | null; label: string; preview: string; siteUrl: string; messageId?: string; mediaUrl?: string | null; mediaType?: string | null; now?: Date },
): Promise<'opened' | 'already_open' | 'nobody'> {
  const now = args.now ?? new Date()
  const { data: open } = await db
    .from('conversation_escalations')
    .select('id, notified_user_ids')
    .eq('conversation_id', args.conversationId)
    .eq('status', 'open')
    .limit(1)
  const item: RelayItem = { messageId: args.messageId ?? `msg-${args.conversationId}-${now.getTime()}`, text: args.preview || null, mediaUrl: args.mediaUrl ?? null, mediaType: args.mediaType ?? null }
  if (open && open.length > 0) {
    // Another message while someone has the chat: it follows to the same person.
    const current = (open[0].notified_user_ids ?? []).at(-1)
    const who = (await loadResponders(db, args.accountId)).find((p) => p.userId === current)
    if (who?.alertPhone) {
      await forwardToResponder(db, { accountId: args.accountId, conversationId: args.conversationId, to: who, items: [item], intro: false }).catch(() => 0)
    }
    return 'already_open'
  }

  const everyone = await loadResponders(db, args.accountId)
  const chain = buildChain(everyone)
  // The person who answered this guest last time gets the chat again, if on duty.
  const { data: past } = await db.from('relay_forwards').select('user_id, created_at').eq('conversation_id', args.conversationId)
  const lastUser = [...(past ?? [])].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.user_id
  const previous = chain.find((m) => m.userId === lastUser)
  const first = previous ?? nextResponder(chain, [])
  if (!first) return 'nobody'

  const minutes = await escalateMinutes(db, args.accountId)
  const { error } = await db.from('conversation_escalations').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    stay_id: args.stayId,
    status: 'open',
    notified_user_ids: [first.userId],
    opened_at: now.toISOString(),
    last_notified_at: now.toISOString(),
    due_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
  })
  if (error) return 'already_open' // lost a race with another delivery of the same message
  await alertResponder(db, args.accountId, first, { label: args.label, preview: args.preview, siteUrl: args.siteUrl, escalated: false, conversationId: args.conversationId, items: [item] })
  return 'opened'
}

export interface EscalationSummary {
  replied: number
  escalated: number
  exhausted: number
}

export async function runEscalations(db: SupabaseClient, siteUrl: string, now: Date = new Date()): Promise<EscalationSummary> {
  const out: EscalationSummary = { replied: 0, escalated: 0, exhausted: 0 }
  const { data: open } = await db
    .from('conversation_escalations')
    .select('id, account_id, conversation_id, stay_id, notified_user_ids, opened_at, due_at')
    .eq('status', 'open')
    .limit(200)
  for (const esc of open ?? []) {
    const { data: replies } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', esc.conversation_id)
      .eq('sender_type', 'agent')
      .gt('created_at', esc.opened_at)
      .limit(1)
    const chainAll = await loadResponders(db, esc.account_id)
    const chain = buildChain(chainAll)
    const action = decide({
      replied: !!replies && replies.length > 0,
      dueAt: new Date(esc.due_at),
      now,
      chain,
      notified: esc.notified_user_ids ?? [],
    })
    if (action === 'wait') continue

    if (action === 'resolve_replied' || action === 'exhausted') {
      await db
        .from('conversation_escalations')
        .update({ status: 'resolved', resolved_at: now.toISOString(), resolved_reason: action === 'exhausted' ? 'unanswered' : 'replied' })
        .eq('id', esc.id)
        .eq('status', 'open')
      if (action === 'exhausted') out.exhausted++
      else out.replied++
      continue
    }

    // advance to the next person
    const told: string[] = [...(esc.notified_user_ids ?? [])]
    const next = nextResponder(chain, told)!
    const minutes = await escalateMinutes(db, esc.account_id)
    const { data: claimed } = await db
      .from('conversation_escalations')
      .update({
        notified_user_ids: [...told, next.userId],
        last_notified_at: now.toISOString(),
        due_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      })
      .eq('id', esc.id)
      .eq('status', 'open')
      .eq('due_at', esc.due_at) // only one runner moves it on
      .select('id')
    if (!claimed || claimed.length === 0) continue

    const label = await labelFor(db, esc.account_id, esc.conversation_id, esc.stay_id)
    const items = await unansweredGuestMessages(db, esc.conversation_id, esc.opened_at)
    const previousId = told.at(-1)
    const prevPerson = everyoneNow(chainAll, previousId)
    await alertResponder(db, esc.account_id, next, {
      label,
      preview: items.at(-1)?.text ?? 'Open the inbox to read and reply.',
      siteUrl,
      escalated: true,
      conversationId: esc.conversation_id,
      items,
      movedFrom: prevPerson?.name ?? null,
    })
    if (prevPerson?.alertPhone) {
      await tell(db, esc.account_id, prevPerson.alertPhone, `↪️ ${label} moved to ${next.name ?? 'the next person'}: no reply within ${minutes} min.`)
    }
    out.escalated++
  }
  return out
}

async function labelFor(db: SupabaseClient, accountId: string, conversationId: string, stayId: string | null): Promise<string> {
  if (stayId) {
    const { data } = await db.from('stays').select('stay_ref, guest_name').eq('id', stayId).maybeSingle()
    if (data) return `${String(data.guest_name).split(/\s+/)[0]} (${data.stay_ref})`
  }
  const { data: conv } = await db.from('conversations').select('contact:contacts(name)').eq('id', conversationId).eq('account_id', accountId).maybeSingle()
  const name = (conv as { contact?: { name?: string } | null } | null)?.contact?.name
  return name ? String(name).split(/\s+/)[0] : 'a guest'
}

function everyoneNow(all: Responder[], userId: string | undefined): Responder | undefined {
  return all.find((p) => p.userId === userId)
}
