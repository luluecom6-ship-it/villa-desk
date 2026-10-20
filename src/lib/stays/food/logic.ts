// Food ordering over WhatsApp: pure rules (tested in food.test.ts).
// The guest sees a numbered list and replies with numbers: "1", "1, 3", "2x2, 1".

export interface MenuItem {
  id: string
  name: string
  price: number
}
export interface OrderLine {
  name: string
  price: number
  qty: number
}

export const MAX_QTY = 20

export const inr = (n: number): string => `INR ${Number.isInteger(n) ? n : n.toFixed(2)}`

/** "1. Idli - INR 100" */
export function menuListText(items: MenuItem[]): string {
  return items.map((it, i) => `${i + 1}. ${it.name} - ${inr(it.price)}`).join('\n')
}

export const ORDER_HOW = 'Reply with the item numbers to order, for example *1, 3* (one Idli and one Veg Biryani) or *2x2, 1* (two of item 2 and one of item 1).'

export type ParsedOrder =
  | { kind: 'order'; lines: OrderLine[]; total: number }
  | { kind: 'unknown_items'; numbers: number[] }
  | { kind: 'text' } // not an order: a note for the caretaker

/**
 * "1", "1,3", "1 3", "2x2", "2 x 2", "2*2", "1 and 3". Every part must be a number or number x quantity;
 * anything else (words) is a note, not an order. Numbers outside the menu are reported.
 */
export function parseOrder(text: string, items: MenuItem[]): ParsedOrder {
  const t = (text ?? '')
    .toLowerCase()
    .replace(/(\d)\s*[x×*]\s*(\d)/g, '$1x$2')
    .replace(/\band\b/g, ',')
    .replace(/[+&;\n]/g, ',')
  const parts = t.split(/[,\s]+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 30) return { kind: 'text' }
  const want = new Map<number, number>()
  for (const p of parts) {
    const m = /^(\d{1,3})(?:x(\d{1,2}))?$/.exec(p)
    if (!m) return { kind: 'text' }
    const n = Number(m[1])
    const qty = m[2] ? Number(m[2]) : 1
    if (qty < 1) return { kind: 'text' }
    want.set(n, Math.min(MAX_QTY, (want.get(n) ?? 0) + qty))
  }
  const unknown = [...want.keys()].filter((n) => n < 1 || n > items.length)
  if (unknown.length > 0) return { kind: 'unknown_items', numbers: unknown }
  const lines = [...want.entries()].sort((a, b) => a[0] - b[0]).map(([n, qty]) => ({ name: items[n - 1].name, price: items[n - 1].price, qty }))
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0)
  return { kind: 'order', lines, total: Math.round(total * 100) / 100 }
}

export const orderLinesText = (lines: OrderLine[]): string => lines.map((l) => `${l.qty} × ${l.name} - ${inr(l.price * l.qty)}`).join('\n')

export function guestOrderReceived(lines: OrderLine[], total: number): string {
  return `🍽️ We received your order:\n${orderLinesText(lines)}\n\n*Total: ${inr(total)}*\n\nWe have sent it to the caretaker. You will get a message here as soon as it is confirmed.`
}

export function guestOrderConfirmed(lines: OrderLine[], total: number): string {
  return `✅ Your order is confirmed and will be delivered to the villa shortly:\n${orderLinesText(lines)}\n\n*Total: ${inr(total)}*`
}

export function guestOrderDeclined(reason: string | null): string {
  return `Sorry, we cannot take this order right now${reason ? `: ${reason}` : '.'}\nWrite *hi* and choose Food to order something else.`
}

/** What the caretaker sees for a new order (the first thing in the forwarded WhatsApp copy). */
export function caretakerOrderText(orderNo: number, lines: OrderLine[], total: number): string {
  return `🍽️ *Food order F${orderNo}*\n${orderLinesText(lines)}\n*Total: ${inr(total)}*\n\nReply */ok* to confirm or */no reason* to decline.`
}

export const FOOD_NOT_READY = 'Our food menu is not ready yet. Please write *hi* and choose the caretaker, and they will help you.'
export const FOOD_RETRY = 'Please reply with numbers from the menu, for example *1, 3* or *2x2*.'
export const FOOD_NOTE_THANKS = 'Thank you! We have passed your note to the caretaker. They will reply here shortly.'

// ---- UPI payment -------------------------------------------------------------------------

/** A UPI address (VPA) such as name@okhdfcbank. */
export const UPI_ID = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,30}$/

export function cleanUpiId(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return UPI_ID.test(t) ? t : null
}

/** The payment link encoded in the QR. Amount in rupees with two decimals; the order number is the note. */
export function buildUpiUri(args: { upiId: string; payeeName: string; amount: number; orderNo: number }): string {
  const q = new URLSearchParams({
    pa: args.upiId,
    pn: args.payeeName.trim().slice(0, 50) || 'Villa',
    am: (Math.round(args.amount * 100) / 100).toFixed(2),
    cu: 'INR',
    tn: `Food order F${args.orderNo}`,
  })
  // URLSearchParams writes spaces as "+"; UPI apps expect %20.
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`
}

export function guestPaymentText(args: { orderNo: number; total: number; upiId: string }): string {
  return `💳 *Pay ${inr(args.total)}* for order F${args.orderNo}\nScan this QR with any UPI app (GPay, PhonePe, Paytm), or pay to UPI ID: ${args.upiId}\nAfter paying, please send the screenshot here.`
}
