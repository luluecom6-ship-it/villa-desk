/* eslint-disable @typescript-eslint/no-explicit-any -- rows from untyped supabase selects */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendText } from '@/lib/evolution/client'
import { recordSend, sendGate } from '@/lib/evolution/safety-server'
import { connFromRow, loadEvolutionConfig } from '@/lib/evolution/server'
import { buildChain, decide, nextResponder, type Responder } from './plan'

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
    .select('user_id, account_role, available, alert_phone, created_at')
    .eq('account_id', accountId)
  return (data ?? []).map((p: any) => ({
    userId: p.user_id,
    role: p.account_role,
    available: p.available !== false,
    alertPhone: p.alert_phone ?? null,
    createdAt: p.created_at ?? '',
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
  try {
    const cfg = await loadEvolutionConfig(accountId, db)
    if (!cfg || (await sendGate(accountId, 'reply', { db, cfg }))) return
    await sendText(connFromRow(cfg), phone, text)
    await recordSend(accountId, { ok: true, kind: 'reply', phone }, db)
  } catch (e) {
    console.error('[team-alert] whatsapp failed:', (e as { status?: number })?.status ?? 'error')
  }
}

/** Bell in the app, and a WhatsApp from the villa number if the person set an alert number. */
export async function alertResponder(
  db: SupabaseClient,
  accountId: string,
  to: Responder,
  info: { label: string; preview: string; siteUrl: string; escalated: boolean },
): Promise<void> {
  const title = `${info.escalated ? 'Not answered yet: ' : ''}Guest message: ${info.label}`
  await db
    .from('notifications')
    .insert({ account_id: accountId, user_id: to.userId, type: 'stay_alert', title: clip(title, 200), body: clip(info.preview, 200) })
    .then(({ error }: { error: { code?: string } | null }) => {
      if (error) console.error('[escalation] bell failed:', error.code)
    })

  if (!to.alertPhone) return
  try {
    const cfg = await loadEvolutionConfig(accountId, db)
    if (!cfg || (await sendGate(accountId, 'reply', { db, cfg }))) return
    const text =
      `${info.escalated ? 'Still no reply. ' : ''}Guest message from ${info.label}:\n"${clip(info.preview, 160)}"\n\n` +
      `Please reply in the app: ${info.siteUrl}/inbox`
    await sendText(connFromRow(cfg), to.alertPhone, text)
    await recordSend(accountId, { ok: true, kind: 'reply', phone: to.alertPhone }, db)
  } catch (e) {
    console.error('[escalation] whatsapp alert failed:', (e as { status?: number })?.status ?? 'error')
  }
}

export async function openEscalation(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; stayId: string | null; label: string; preview: string; siteUrl: string; now?: Date },
): Promise<'opened' | 'already_open' | 'nobody'> {
  const now = args.now ?? new Date()
  const { data: open } = await db
    .from('conversation_escalations')
    .select('id')
    .eq('conversation_id', args.conversationId)
    .eq('status', 'open')
    .limit(1)
  if (open && open.length > 0) return 'already_open'

  const chain = buildChain(await loadResponders(db, args.accountId))
  const first = nextResponder(chain, [])
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
  await alertResponder(db, args.accountId, first, { label: args.label, preview: args.preview, siteUrl: args.siteUrl, escalated: false })
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
    const chain = buildChain(await loadResponders(db, esc.account_id))
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
    const next = nextResponder(chain, esc.notified_user_ids ?? [])!
    const minutes = await escalateMinutes(db, esc.account_id)
    const { data: claimed } = await db
      .from('conversation_escalations')
      .update({
        notified_user_ids: [...(esc.notified_user_ids ?? []), next.userId],
        last_notified_at: now.toISOString(),
        due_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      })
      .eq('id', esc.id)
      .eq('status', 'open')
      .eq('due_at', esc.due_at) // only one runner moves it on
      .select('id')
    if (!claimed || claimed.length === 0) continue

    const label = await labelFor(db, esc.account_id, esc.conversation_id, esc.stay_id)
    await alertResponder(db, esc.account_id, next, { label, preview: 'Open the inbox to read and reply.', siteUrl, escalated: true })
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
