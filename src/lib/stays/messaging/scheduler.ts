import type { SupabaseClient } from '@supabase/supabase-js'
import { AUTOMATION_CLOSE_DAYS } from '../automation'
import { stayFormUrl } from '../server'
import { judge, type ConditionGuest } from './conditions'
import { notifyStaff } from './notify'
import {
  computeSchedule,
  effectiveDueAt,
  isWindowExempt,
  isStaffAlert,
  type MessageKey,
} from './schedule'
import { runEscalations } from '../escalation/server'
import { logStayMessage, sendStayWhatsApp, type StayTransport } from './send'
import {
  DEFAULT_TEMPLATES,
  META_TEMPLATE_PARAMS,
  firstName,
  renderTemplate,
  type TemplateValues,
} from './templates'

// The stay-message scheduler (PDR 7.3). Called every 15 minutes by an external
// scheduler through /api/stays/cron.
//
//   1. enqueue: for every stay that is ready for automation, make sure each
//      message has a row (unique per stay + key, so running twice is harmless)
//      and keep queued due times in step with edited dates.
//   2. process: send what is due. A row is claimed (queued -> sending) before
//      anything is sent, so two overlapping runs never send the same message.

const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 3
export const RETRY_DELAY_MS = 15 * 60 * 1000
const BATCH = 100

const REMINDER_KEYS: readonly MessageKey[] = ['form_reminder_3d', 'form_reminder_2d', 'form_reminder_1d']

interface StayRow {
  id: string
  account_id: string
  property_id: string
  stay_ref: string
  guest_name: string
  guest_phone: string | null
  status: string
  form_status: string
  form_token: string
  checkin_at: string
  checkout_at: string
  created_at: string
}

interface PropertyRow {
  id: string
  name: string
  address: string | null
  map_url: string | null
  directions: string | null
  review_url: string | null
  access_instructions: string | null
  caretaker_phone: string | null
  default_checkin_time: string
  default_checkout_time: string
  deposit_refund_days: number
}

export interface SchedulerSummary {
  stays: number
  queued: number
  sent: number
  waiting: number
  skipped: number
  blocked: number
  retried: number
  failed: number
  alerts: number
}

export interface SchedulerOptions {
  requestUrl: string
  now?: Date
  transport?: StayTransport
}

function siteUrlFrom(requestUrl: string): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (env) return env
  try {
    return new URL(requestUrl).origin
  } catch {
    return ''
  }
}

const hhmm = (t: string): string => (t ?? '').slice(0, 5)

export function buildValues(
  stay: StayRow,
  property: PropertyRow | undefined,
  requestUrl: string,
): TemplateValues {
  return {
    guest_first_name: firstName(stay.guest_name),
    stay_ref: stay.stay_ref,
    form_url: stayFormUrl(requestUrl, stay.form_token),
    property_name: property?.name ?? '',
    address: property?.address ?? '',
    map_url: property?.map_url ?? '',
    directions: property?.directions ?? '',
    checkin_time: hhmm(property?.default_checkin_time ?? '14:00') + ' (IST)',
    checkout_time: hhmm(property?.default_checkout_time ?? '11:00') + ' (IST)',
    access_instructions: property?.access_instructions ?? '',
    caretaker_phone: property?.caretaker_phone ?? '',
    review_url: property?.review_url ?? '',
    refund_days: String(property?.deposit_refund_days ?? 3),
  }
}

// ---------------------------------------------------------------- enqueue

export async function enqueueStayMessages(db: SupabaseClient, now: Date): Promise<number> {
  const earliestCheckout = new Date(now.getTime() - AUTOMATION_CLOSE_DAYS * DAY_MS).toISOString()
  const { data: stays } = await db
    .from('stays')
    .select('id, account_id, checkin_at, checkout_at, created_at')
    .eq('automation_ready', true)
    .gte('checkout_at', earliestCheckout)
    .limit(1000)
  if (!stays || stays.length === 0) return 0

  const { data: existing } = await db
    .from('stay_messages')
    .select('id, stay_id, message_key, due_at, status')
    .in('stay_id', stays.map((s: { id: string }) => s.id))
  const byStay = new Map<string, Map<string, { id: string; due_at: string; status: string }>>()
  for (const row of existing ?? []) {
    const m = byStay.get(row.stay_id) ?? new Map()
    m.set(row.message_key, row)
    byStay.set(row.stay_id, m)
  }

  const inserts: Record<string, unknown>[] = []
  for (const stay of stays) {
    const have = byStay.get(stay.id) ?? new Map()
    for (const { key, dueAt } of computeSchedule(stay)) {
      const row = have.get(key)
      if (!row) {
        // A reminder whose day has already passed when the stay is first seen
        // is skipped, so a late booking does not get all of them at once.
        const stale = REMINDER_KEYS.includes(key) && dueAt < now
        inserts.push({
          account_id: stay.account_id,
          stay_id: stay.id,
          message_key: key,
          due_at: dueAt.toISOString(),
          status: stale ? 'skipped_condition' : 'queued',
          last_error: stale ? 'past_at_registration' : null,
        })
      } else if (
        row.status === 'queued' &&
        key !== 'form_link' &&
        new Date(row.due_at).getTime() !== dueAt.getTime()
      ) {
        // Dates were edited: move the queued message with them.
        await db.from('stay_messages').update({ due_at: dueAt.toISOString() }).eq('id', row.id).eq('status', 'queued')
      }
    }
  }

  let created = 0
  for (let i = 0; i < inserts.length; i += 200) {
    const chunk = inserts.slice(i, i + 200)
    const { data, error } = await db
      .from('stay_messages')
      .upsert(chunk, { onConflict: 'stay_id,message_key', ignoreDuplicates: true })
      .select('id')
    if (error) console.error('[stay-scheduler] enqueue failed:', error.code)
    else created += data?.length ?? 0
  }
  return created
}

// A row left in 'sending' means a run died mid-send. We cannot know whether the
// message left, and the rule is never twice, so it is NOT retried: it is marked
// failed ('interrupted') and staff are told to check the conversation.
export const STALE_SENDING_MS = 30 * 60 * 1000

export async function settleInterrupted(db: SupabaseClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS).toISOString()
  const { data } = await db
    .from('stay_messages')
    .update({ status: 'failed', last_error: 'interrupted' })
    .eq('status', 'sending')
    .lte('updated_at', cutoff)
    .select('id, account_id, stay_id, message_key')
  let alerts = 0
  for (const r of data ?? []) {
    await logStayMessage(db, { accountId: r.account_id, stayId: r.stay_id, messageKey: r.message_key, outcome: 'failed', reason: 'interrupted' })
    await notifyStaff(db, r.account_id, `Check message: ${r.message_key} may not have been sent`, 'A run stopped mid-send. Open the guest conversation to see whether it arrived before resending by hand.')
    alerts++
  }
  return alerts
}

// ---------------------------------------------------------------- process

export async function runStayScheduler(
  db: SupabaseClient,
  options: SchedulerOptions,
): Promise<SchedulerSummary> {
  const now = options.now ?? new Date()
  const summary: SchedulerSummary = {
    stays: 0, queued: 0, sent: 0, waiting: 0, skipped: 0, blocked: 0, retried: 0, failed: 0, alerts: 0,
  }

  summary.alerts += await settleInterrupted(db, now)
  // Move unanswered guest messages on to the next agent, then the owner.
  try {
    await runEscalations(db, siteUrlFrom(options.requestUrl), now)
  } catch (err) {
    console.error('[escalation] run failed:', (err as { code?: string })?.code ?? 'error')
  }
  summary.queued = await enqueueStayMessages(db, now)

  const { data: due } = await db
    .from('stay_messages')
    .select('id, account_id, stay_id, message_key, due_at, attempts, next_attempt_at')
    .eq('status', 'queued')
    .lte('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(BATCH)
  const candidates = (due ?? []).filter(
    (r: { message_key: MessageKey; due_at: string; next_attempt_at: string | null }) =>
      effectiveDueAt(r.message_key, new Date(r.due_at)) <= now &&
      (!r.next_attempt_at || new Date(r.next_attempt_at) <= now),
  )
  if (candidates.length === 0) return summary

  const stayIds = [...new Set(candidates.map((r: { stay_id: string }) => r.stay_id))]
  const [{ data: stays }, { data: guests }] = await Promise.all([
    db.from('stays')
      .select('id, account_id, property_id, stay_ref, guest_name, guest_phone, status, form_status, form_token, checkin_at, checkout_at, created_at')
      .in('id', stayIds),
    db.from('stay_guests').select('stay_id, is_adult, id_verified_at').in('stay_id', stayIds),
  ])
  const stayById = new Map<string, StayRow>((stays ?? []).map((s: StayRow) => [s.id, s]))
  summary.stays = stayById.size
  const guestsByStay = new Map<string, ConditionGuest[]>()
  for (const g of guests ?? []) {
    const list = guestsByStay.get(g.stay_id) ?? []
    list.push(g)
    guestsByStay.set(g.stay_id, list)
  }
  const propertyIds = [...new Set([...stayById.values()].map((s) => s.property_id))]
  const accountIds = [...new Set(candidates.map((r: { account_id: string }) => r.account_id))]
  const [{ data: properties }, { data: templates }] = await Promise.all([
    db.from('properties')
      .select('id, name, address, map_url, directions, review_url, access_instructions, caretaker_phone, default_checkin_time, default_checkout_time, deposit_refund_days')
      .in('id', propertyIds),
    db.from('stay_message_templates')
      .select('account_id, message_key, body, meta_template_name')
      .in('account_id', accountIds),
  ])
  const propById = new Map<string, PropertyRow>((properties ?? []).map((p: PropertyRow) => [p.id, p]))
  const tplByKey = new Map<string, { body: string; meta_template_name: string | null }>(
    (templates ?? []).map((t: { account_id: string; message_key: string; body: string; meta_template_name: string | null }) => [`${t.account_id}:${t.message_key}`, t]),
  )

  for (const row of candidates as Array<{
    id: string; account_id: string; stay_id: string; message_key: MessageKey; attempts: number
  }>) {
    const stay = stayById.get(row.stay_id)
    if (!stay) continue

    // Claim. If another run got it first, this finds nothing and moves on.
    const { data: claimed } = await db
      .from('stay_messages')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    const finish = (status: string, extra: Record<string, unknown> = {}) =>
      db.from('stay_messages').update({ status, ...extra }).eq('id', row.id)

    if (stay.status === 'cancelled') {
      await finish('cancelled', { last_error: 'stay_cancelled' })
      await logStayMessage(db, { accountId: row.account_id, stayId: stay.id, messageKey: row.message_key, outcome: 'cancelled', reason: 'stay_cancelled' })
      summary.skipped++
      continue
    }

    const judgement = judge(row.message_key, stay, guestsByStay.get(stay.id) ?? [], now)
    if (judgement.verdict === 'skip') {
      await finish('skipped_condition', { last_error: judgement.reason })
      await logStayMessage(db, { accountId: row.account_id, stayId: stay.id, messageKey: row.message_key, outcome: 'skipped_condition', reason: judgement.reason })
      summary.skipped++
      continue
    }
    if (judgement.verdict === 'wait') {
      await finish('queued', { last_error: judgement.reason })
      summary.waiting++
      continue
    }

    const property = propById.get(stay.property_id)
    const values = buildValues(stay, property, options.requestUrl)
    const override = tplByKey.get(`${row.account_id}:${row.message_key}`)
    const text = renderTemplate(override?.body ?? DEFAULT_TEMPLATES[row.message_key], values)

    // Internal alerts: to the team, not to the guest, so no WhatsApp gate.
    if (isStaffAlert(row.message_key)) {
      const sentTo = await notifyStaff(db, row.account_id, text, null)
      if (sentTo > 0) {
        await finish('sent', { sent_at: now.toISOString(), last_error: null })
        await logStayMessage(db, { accountId: row.account_id, stayId: stay.id, messageKey: row.message_key, outcome: 'sent', reason: 'staff_alert' })
        summary.alerts++
      } else {
        await finish('queued', { last_error: 'no_staff_recipients', next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS).toISOString() })
        summary.retried++
      }
      continue
    }

    if (!stay.guest_phone) {
      await finish('blocked_not_registered', { last_error: 'no_mobile' })
      await logStayMessage(db, { accountId: row.account_id, stayId: stay.id, messageKey: row.message_key, outcome: 'blocked_not_registered', reason: 'no_mobile' })
      summary.blocked++
      continue
    }

    const template = override?.meta_template_name
      ? {
          name: override.meta_template_name,
          params: META_TEMPLATE_PARAMS[row.message_key].map((v) => values[v] ?? ''),
        }
      : undefined

    const result = await sendStayWhatsApp(db, {
      accountId: row.account_id,
      stayId: stay.id,
      phone: stay.guest_phone,
      guestName: stay.guest_name,
      messageKey: row.message_key,
      text,
      template,
      enforceWindow: !isWindowExempt(row.message_key),
      kind: row.message_key === 'form_link' ? 'immediate' : 'scheduled',
      now,
      transport: options.transport,
    })

    if (result.outcome === 'sent') {
      await finish('sent', { sent_at: now.toISOString(), wa_message_id: result.messageId, last_error: null })
      summary.sent++
    } else if (result.outcome === 'blocked') {
      await finish('blocked_not_registered', { last_error: result.reason })
      summary.blocked++
    } else if (result.outcome === 'waiting') {
      await finish('queued')
      summary.waiting++
    } else {
      const attempts = row.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        await finish('failed', { attempts, last_error: result.reason })
        await notifyStaff(
          db,
          row.account_id,
          `Message not sent: ${row.message_key} for ${stay.stay_ref}`,
          `Tried ${attempts} times (${result.reason}). Check the WhatsApp connection or message the guest manually.`,
        )
        summary.failed++
      } else {
        await finish('queued', {
          attempts,
          last_error: result.reason,
          next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
        })
        summary.retried++
      }
    }
  }

  return summary
}
