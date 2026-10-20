/* eslint-disable @typescript-eslint/no-explicit-any -- rows from untyped supabase selects */
import type { SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { openEscalation } from '../escalation/server'
import { sendStayWhatsApp, type SendOutcome, type StayTransport } from '../messaging/send'
import {
  ORDER_HOW,
  caretakerOrderText,
  guestOrderConfirmed,
  guestOrderDeclined,
  guestOrderReceived,
  guestPaymentText,
  buildUpiUri,
  menuListText,
  type MenuItem,
  type OrderLine,
} from './logic'

// Food ordering, database + WhatsApp side. Rules live in ./logic.ts.

export interface StayRef {
  id: string
  guest_phone: string
  guest_name: string
}

export async function loadMenu(db: SupabaseClient, accountId: string): Promise<{ items: MenuItem[]; imageUrl: string | null }> {
  const [{ data: rows }, { data: props }] = await Promise.all([
    db.from('food_items').select('id, name, price, sort_order, created_at').eq('account_id', accountId).eq('active', true),
    db.from('properties').select('food_menu_image_url').eq('account_id', accountId).limit(1),
  ])
  const items = [...(rows ?? [])]
    .sort((a: any, b: any) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)))
    .map((r: any) => ({ id: String(r.id), name: String(r.name), price: Number(r.price) }))
  return { items, imageUrl: ((props?.[0] as any)?.food_menu_image_url as string | null) ?? null }
}

const send = (db: SupabaseClient, accountId: string, stay: StayRef, key: string, text: string, extra: { media?: { url: string; kind: 'image' }; now?: Date; transport?: StayTransport } = {}): Promise<SendOutcome> =>
  sendStayWhatsApp(db, {
    accountId,
    stayId: stay.id,
    phone: stay.guest_phone,
    guestName: stay.guest_name,
    messageKey: key,
    text,
    enforceWindow: false,
    kind: 'reply',
    now: extra.now,
    transport: extra.transport,
    media: extra.media,
  })

/** Send the menu picture and the numbered list. False when there is no menu yet. */
export async function sendFoodMenu(db: SupabaseClient, args: { accountId: string; stay: StayRef; now?: Date; transport?: StayTransport }): Promise<boolean> {
  const { items, imageUrl } = await loadMenu(db, args.accountId)
  if (items.length === 0) return false
  const opts = { now: args.now, transport: args.transport }
  if (imageUrl) await send(db, args.accountId, args.stay, 'menu_food_image', 'Our food menu 🍽️', { ...opts, media: { url: imageUrl, kind: 'image' } })
  await send(db, args.accountId, args.stay, 'menu_food_list', `*Food menu*\n${menuListText(items)}\n\n${ORDER_HOW}`, opts)
  return true
}

/** Save the order, tell the caretaker (WhatsApp + bell, chased like any guest message) and confirm receipt to the guest. */
export async function placeOrder(
  db: SupabaseClient,
  args: { accountId: string; stay: StayRef; conversationId: string | undefined; lines: OrderLine[]; total: number; messageId?: string; siteUrl: string; label: string; now?: Date; transport?: StayTransport; report?: (d: string) => void },
): Promise<{ orderNo: number } | null> {
  const { data, error } = await db
    .from('food_orders')
    .insert({ account_id: args.accountId, stay_id: args.stay.id, conversation_id: args.conversationId ?? null, guest_name: args.stay.guest_name, items: args.lines, total: args.total })
    .select('id, order_no')
  if (error || !data?.[0]) {
    console.error('[food] could not save the order:', error?.code ?? 'error')
    return null
  }
  const orderNo = Number((data[0] as any).order_no)
  const preview = caretakerOrderText(orderNo, args.lines, args.total)
  if (args.conversationId) {
    await openEscalation(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      stayId: args.stay.id,
      label: args.label,
      preview,
      messageId: args.messageId ? `${args.messageId}-order` : undefined,
      siteUrl: args.siteUrl,
      now: args.now,
      report: args.report,
    })
  }
  await send(db, args.accountId, args.stay, 'food_order_received', guestOrderReceived(args.lines, args.total), { now: args.now, transport: args.transport })
  return { orderNo }
}

export type DecideResult =
  | { ok: true; orderNo: number; guestMessage: SendOutcome['outcome'] }
  | { ok: false; error: 'not_found' | 'already_decided' }

/** Approve or decline an order (the dashboard, or /ok and /no from the caretaker's WhatsApp). The guest is told. */
export async function decideOrder(
  db: SupabaseClient,
  args: { accountId: string; orderId?: string; conversationId?: string; decision: 'confirmed' | 'declined'; byUserId: string | null; byName: string | null; reason?: string | null; now?: Date; transport?: StayTransport },
): Promise<DecideResult> {
  const now = args.now ?? new Date()
  let q = db.from('food_orders').select('id, order_no, stay_id, conversation_id, items, total, status, created_at').eq('account_id', args.accountId)
  if (args.orderId) q = q.eq('id', args.orderId)
  else if (args.conversationId) q = q.eq('conversation_id', args.conversationId).eq('status', 'pending')
  else return { ok: false, error: 'not_found' }
  const { data: found } = await q
  const order = [...(found ?? [])].sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0] as any
  if (!order) return { ok: false, error: 'not_found' }
  if (order.status !== 'pending') return { ok: false, error: 'already_decided' }

  const reason = args.decision === 'declined' ? (args.reason?.trim().slice(0, 300) || null) : null
  const { data: updated } = await db
    .from('food_orders')
    .update({ status: args.decision, decided_by: args.byUserId, decided_by_name: args.byName, decided_at: now.toISOString(), decline_reason: reason })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select('id')
  if (!updated || updated.length === 0) return { ok: false, error: 'already_decided' }

  // The caretaker has answered: stop chasing others about this chat.
  if (order.conversation_id) {
    await db.from('conversation_escalations').update({ status: 'resolved', resolved_at: now.toISOString(), resolved_reason: 'replied' }).eq('conversation_id', order.conversation_id).eq('status', 'open')
  }

  let outcome: SendOutcome['outcome'] = 'blocked'
  if (order.stay_id) {
    const { data: stay } = await db.from('stays').select('id, guest_phone, guest_name').eq('id', order.stay_id).maybeSingle()
    if (stay?.guest_phone) {
      const lines = order.items as OrderLine[]
      const text = args.decision === 'confirmed' ? guestOrderConfirmed(lines, Number(order.total)) : guestOrderDeclined(reason)
      const r = await send(db, args.accountId, stay as StayRef, args.decision === 'confirmed' ? 'food_order_confirmed' : 'food_order_declined', text, { now, transport: args.transport })
      outcome = r.outcome
      if (args.decision === 'confirmed') {
        await sendUpiQr(db, { accountId: args.accountId, stay: stay as StayRef, orderId: order.id, orderNo: Number(order.order_no), total: Number(order.total), now, transport: args.transport }).catch((e) =>
          console.error('[food] UPI QR failed:', e instanceof Error ? e.message : 'error'),
        )
      }
    }
  }
  return { ok: true, orderNo: Number(order.order_no), guestMessage: outcome }
}


/** After a confirmation: send the guest a UPI QR for the total (if the owner saved a UPI ID and left this on). */
export async function sendUpiQr(
  db: SupabaseClient,
  args: { accountId: string; stay: StayRef; orderId: string; orderNo: number; total: number; now?: Date; transport?: StayTransport },
): Promise<'sent' | 'not_configured' | 'failed'> {
  const { data: props } = await db.from('properties').select('upi_id, upi_payee_name, name, food_send_upi_qr').eq('account_id', args.accountId).order('created_at', { ascending: true }).limit(1)
  const p = props?.[0] as any
  if (!p?.upi_id || p.food_send_upi_qr === false || !(args.total > 0)) return 'not_configured'
  const uri = buildUpiUri({ upiId: p.upi_id, payeeName: p.upi_payee_name || p.name || 'Villa', amount: args.total, orderNo: args.orderNo })
  const png = await QRCode.toBuffer(uri, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' })
  const path = buildMediaPath(args.accountId, `upi-F${args.orderNo}.png`, Date.now(), 'food')
  const storage = db.storage.from('chat-media')
  const { error } = await storage.upload(path, new Uint8Array(png), { contentType: 'image/png', cacheControl: '3600', upsert: false })
  if (error) return 'failed'
  const url = storage.getPublicUrl(path).data.publicUrl
  const r = await send(db, args.accountId, args.stay, 'food_order_payment', guestPaymentText({ orderNo: args.orderNo, total: args.total, upiId: p.upi_id }), { now: args.now, transport: args.transport, media: { url, kind: 'image' } })
  if (r.outcome !== 'sent') return 'failed'
  await db.from('food_orders').update({ qr_sent_at: (args.now ?? new Date()).toISOString() }).eq('id', args.orderId)
  return 'sent'
}

/** Mark an order paid by hand (caretaker and above). Idempotent. */
export async function markOrderPaid(db: SupabaseClient, args: { accountId: string; orderId: string; byName: string | null; now?: Date }): Promise<'ok' | 'not_found' | 'not_confirmed'> {
  const { data } = await db.from('food_orders').select('id, status, payment_status').eq('id', args.orderId).eq('account_id', args.accountId).maybeSingle()
  const o = data as any
  if (!o) return 'not_found'
  if (o.status !== 'confirmed') return 'not_confirmed'
  if (o.payment_status === 'paid') return 'ok'
  await db.from('food_orders').update({ payment_status: 'paid', paid_at: (args.now ?? new Date()).toISOString(), paid_by_name: args.byName }).eq('id', args.orderId)
  return 'ok'
}
