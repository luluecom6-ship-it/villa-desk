/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory db + mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDb } from '../messaging/test-support'
import { parseOrder, menuListText, buildUpiUri, cleanUpiId, type MenuItem } from './logic'

const m = vi.hoisted(() => ({ sendText: vi.fn(), transport: vi.fn() }))
vi.mock('@/lib/evolution/server', () => ({ loadEvolutionConfig: async () => ({ account_id: 'a1', state: 'open' }), connFromRow: () => ({}) }))
vi.mock('@/lib/evolution/safety-server', () => ({ sendGate: async () => null, recordSend: async () => undefined }))
vi.mock('@/lib/evolution/client', () => ({ sendText: m.sendText, sendMedia: vi.fn(), sendAudio: vi.fn(), sendReaction: vi.fn(), connectionState: vi.fn(), userJid: (n: string) => n }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))

import { handleStayInbound } from '../messaging/inbound'
import { decideOrder, markOrderPaid } from './server'

const MENU: MenuItem[] = [
  { id: 'i1', name: 'Idli', price: 100 },
  { id: 'i2', name: 'Chicken Briyani', price: 170 },
  { id: 'i3', name: 'Veg Briyani', price: 145 },
]

describe('parseOrder', () => {
  it('lists the menu with numbers and INR prices', () => {
    expect(menuListText(MENU)).toBe('1. Idli - INR 100\n2. Chicken Briyani - INR 170\n3. Veg Briyani - INR 145')
  })
  it.each([
    ['1', [['Idli', 1]], 100],
    ['1, 3', [['Idli', 1], ['Veg Briyani', 1]], 245],
    ['1 3', [['Idli', 1], ['Veg Briyani', 1]], 245],
    ['2x2, 1', [['Idli', 1], ['Chicken Briyani', 2]], 440],
    ['2 X 2 and 1', [['Idli', 1], ['Chicken Briyani', 2]], 440],
    ['2*3', [['Chicken Briyani', 3]], 510],
    ['2 2', [['Chicken Briyani', 2]], 340],
  ])('"%s" is an order', (text, lines, total) => {
    const r: any = parseOrder(text as string, MENU)
    expect(r.kind).toBe('order')
    expect(r.lines.map((l: any) => [l.name, l.qty])).toEqual(lines)
    expect(r.total).toBe(total)
  })
  it('numbers outside the menu are reported, not guessed', () => {
    expect(parseOrder('1, 9', MENU)).toEqual({ kind: 'unknown_items', numbers: [9] })
    expect(parseOrder('0', MENU)).toEqual({ kind: 'unknown_items', numbers: [0] })
  })
  it('words make it a note, not an order', () => {
    expect(parseOrder('2 vegetarian thalis at 8 pm', MENU).kind).toBe('text')
    expect(parseOrder('no onion please', MENU).kind).toBe('text')
    expect(parseOrder('', MENU).kind).toBe('text')
  })
})

describe('food ordering over WhatsApp', () => {
  let db: any
  const NOW = new Date('2026-11-10T08:00:00Z')
  const say = (text: string, at = NOW) =>
    handleStayInbound(db, { accountId: 'a1', phone: '919000011111', text, requestUrl: 'https://villa.test/x', conversationId: 'c1', messageId: `M${text}${at.getTime()}`, now: at, transport: m.transport as any })
  const toGuest = () => m.transport.mock.calls.map((c) => c[0].text as string)
  const toAgent = () => m.sendText.mock.calls.filter((c) => c[1] === '966500000002').map((c) => c[2] as string)

  beforeEach(() => {
    vi.clearAllMocks()
    let n = 0
    m.transport.mockImplementation(async () => ({ messageId: 'T' }))
    m.sendText.mockImplementation(async () => ({ id: `W${++n}` }))
    db = new FakeDb()
    db.tables.properties = [{ id: 'p1', account_id: 'a1', villa_mode: true, name: 'Mahinoor Stays', food_menu_image_url: null, escalate_after_minutes: 10 }]
    db.tables.stays = [{ id: 's1', account_id: 'a1', property_id: 'p1', stay_ref: 'MS-1', guest_name: 'Asha Rao', guest_phone: '919000011111', status: 'registered', form_status: 'submitted', form_token: 'tok', automation_ready: true, checkin_at: '2026-11-10T08:30:00Z', checkout_at: '2026-11-12T05:30:00Z', created_at: '2026-11-05T05:00:00Z' }]
    db.tables.stay_guests = [{ stay_id: 's1', is_adult: true, id_verified_at: '2026-11-09T00:00:00Z' }]
    db.tables.profiles = [{ user_id: 'care', account_id: 'a1', account_role: 'agent', created_at: '1', available: true, alert_phone: '966500000002', full_name: 'Ravi' }]
    db.tables.conversations = [{ id: 'c1', account_id: 'a1', relay_code: 482, contact: { name: 'Asha Rao', phone: '+919000011111' } }]
    db.tables.food_items = MENU.map((it, i) => ({ id: it.id, account_id: 'a1', name: it.name, price: it.price, sort_order: i, active: true, created_at: `${i}` }))
    db.tables.food_orders = []
    db.tables.messages = []
  })

  it('Food shows the numbered menu; item numbers become an order the caretaker is asked to approve', async () => {
    await say('hi')
    await say('4')
    expect(toGuest().some((t) => t.includes('1. Idli - INR 100') && t.includes('3. Veg Briyani - INR 145'))).toBe(true)
    await say('2x2, 1')
    const order = db.tables.food_orders[0]
    expect(order).toMatchObject({ status: 'pending', total: 440, stay_id: 's1' })
    expect(order.items).toEqual([{ name: 'Idli', price: 100, qty: 1 }, { name: 'Chicken Briyani', price: 170, qty: 2 }])
    expect(toGuest().at(-1)).toContain('Total: INR 440')
    expect(toAgent().some((t) => t.includes('Food order F') && t.includes('*confirm*'))).toBe(true)
  })

  it('a wrong number asks again and keeps waiting for the order', async () => {
    await say('hi'); await say('4')
    await say('7')
    expect(toGuest().at(-1)).toContain('items 1 to 3')
    expect(db.tables.food_orders).toHaveLength(0)
    await say('1')
    expect(db.tables.food_orders).toHaveLength(1)
  })

  it('a note with words goes to the caretaker as a note, not an order', async () => {
    await say('hi'); await say('4')
    await say('no onion in the idli please')
    expect(db.tables.food_orders).toHaveLength(0)
    expect(toAgent().some((t) => t.includes('Food note'))).toBe(true)
  })

  it('with no menu yet, Food says so', async () => {
    db.tables.food_items = []
    await say('hi'); await say('4')
    expect(toGuest().at(-1)).toContain('not ready yet')
  })

  it('approving tells the guest; deciding twice is refused', async () => {
    await say('hi'); await say('4'); await say('1')
    const id = db.tables.food_orders[0].id
    const r = await decideOrder(db, { accountId: 'a1', orderId: id, decision: 'confirmed', byUserId: 'care', byName: 'Ravi', transport: m.transport as any })
    expect(r).toMatchObject({ ok: true, guestMessage: 'sent' })
    expect(toGuest().at(-1)).toContain('confirmed and will be delivered')
    expect(db.tables.food_orders[0]).toMatchObject({ status: 'confirmed', decided_by_name: 'Ravi' })
    expect(await decideOrder(db, { accountId: 'a1', orderId: id, decision: 'declined', byUserId: 'care', byName: 'Ravi' })).toEqual({ ok: false, error: 'already_decided' })
  })

  it('declining passes the reason to the guest', async () => {
    await say('hi'); await say('4'); await say('3')
    const r = await decideOrder(db, { accountId: 'a1', conversationId: 'c1', decision: 'declined', byUserId: 'care', byName: 'Ravi', reason: 'kitchen is closed', transport: m.transport as any })
    expect(r.ok).toBe(true)
    expect(toGuest().at(-1)).toContain('kitchen is closed')
    expect(db.tables.food_orders[0].status).toBe('declined')
  })

  describe('UPI payment', () => {
    const uploads: string[] = []
    beforeEach(() => {
      uploads.length = 0
      db.storage = { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null } }, getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.test/${path}` } }) }) }
    })
    const placeAndConfirm = async () => {
      await say('hi'); await say('4'); await say('1')
      return decideOrder(db, { accountId: 'a1', orderId: db.tables.food_orders[0].id, decision: 'confirmed', byUserId: 'care', byName: 'Ravi', transport: m.transport as any })
    }
    it('confirming sends the guest a QR picture for the total when a UPI ID is saved', async () => {
      db.tables.properties[0].upi_id = 'mahinoor@okhdfcbank'
      await placeAndConfirm()
      expect(uploads).toHaveLength(1)
      const last = m.transport.mock.calls.at(-1)![0]
      expect(last.media?.url).toContain('https://files.test/')
      expect(last.text).toContain('Pay INR 100')
      expect(last.text).toContain('mahinoor@okhdfcbank')
      expect(db.tables.food_orders[0].qr_sent_at).toBeTruthy()
    })
    it('sends no QR without a UPI ID, when switched off, or when declined', async () => {
      await placeAndConfirm()
      expect(uploads).toHaveLength(0)
      db.tables.properties[0].upi_id = 'mahinoor@okhdfcbank'
      db.tables.properties[0].food_send_upi_qr = false
      db.tables.food_orders = []
      await placeAndConfirm()
      expect(uploads).toHaveLength(0)
    })
    it('marks a confirmed order paid, once, and refuses a pending one', async () => {
      await say('hi'); await say('4'); await say('1')
      const id = db.tables.food_orders[0].id
      expect(await markOrderPaid(db, { accountId: 'a1', orderId: id, byName: 'Ravi' })).toBe('not_confirmed')
      await decideOrder(db, { accountId: 'a1', orderId: id, decision: 'confirmed', byUserId: 'care', byName: 'Ravi', transport: m.transport as any })
      expect(await markOrderPaid(db, { accountId: 'a1', orderId: id, byName: 'Ravi' })).toBe('ok')
      expect(db.tables.food_orders[0]).toMatchObject({ payment_status: 'paid', paid_by_name: 'Ravi' })
      expect(await markOrderPaid(db, { accountId: 'a1', orderId: id, byName: 'Other' })).toBe('ok')
      expect(db.tables.food_orders[0].paid_by_name).toBe('Ravi')
    })
  })
})

describe('UPI helpers', () => {
  it('accepts normal UPI IDs and rejects junk', () => {
    expect(cleanUpiId(' name.x@okhdfcbank ')).toBe('name.x@okhdfcbank')
    expect(cleanUpiId('9876543210@paytm')).toBe('9876543210@paytm')
    for (const bad of ['', 'nobank', 'a@b', 'x y@bank', '@bank', 'https://evil.test']) expect(cleanUpiId(bad)).toBeNull()
  })
  it('builds the payment link with the exact amount and the order note', () => {
    const uri = buildUpiUri({ upiId: 'villa@okaxis', payeeName: 'Mahinoor Stays', amount: 245, orderNo: 12 })
    expect(uri).toBe('upi://pay?pa=villa%40okaxis&pn=Mahinoor%20Stays&am=245.00&cu=INR&tn=Food%20order%20F12')
  })
})
