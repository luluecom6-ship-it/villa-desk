import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleStayInbound, parseInboundCommand } from './inbound'
import { assertVillaSendAllowed, villaAllowsAutomation, VillaBlockedError } from './villa-mode'
import { FakeDb, type Row } from './test-support'

const ist = (s: string) => new Date(s.replace(' ', 'T') + ':00+05:30')
const REQUEST = 'https://villa.test/api/whatsapp/webhook'
const NOW = ist('2026-11-10 08:00') // before check-in; inbound has no send window

let db: FakeDb
let transport: ReturnType<typeof vi.fn>

function seed(stay: Row = {}, withProperty = true) {
  db = new FakeDb()
  db.tables.properties = withProperty
    ? [{ id: 'p1', account_id: 'a1', villa_mode: true, name: 'Mahinoor Stays', access_instructions: 'Code 1234', caretaker_phone: '+919800000000', default_checkin_time: '14:00:00', default_checkout_time: '11:00:00', deposit_refund_days: 3 }]
    : []
  db.tables.stays = [{
    id: 's1', account_id: 'a1', property_id: 'p1', stay_ref: 'MS-2026-001', guest_name: 'Asha Rao', guest_phone: '919000011111',
    status: 'registered', form_status: 'submitted', form_token: 'abcdef0123456a', automation_ready: true, on_the_way_at: null,
    checkin_at: ist('2026-11-10 14:00').toISOString(), checkout_at: ist('2026-11-12 11:00').toISOString(), created_at: ist('2026-11-05 10:30').toISOString(),
    ...stay,
  }]
  db.tables.stay_guests = [{ stay_id: 's1', is_adult: true, id_verified_at: '2026-11-09T00:00:00Z' }]
  db.tables.profiles = [{ user_id: 'owner', account_id: 'a1', account_role: 'owner' }, { user_id: 'care', account_id: 'a1', account_role: 'agent' }]
  transport = vi.fn(async () => ({ messageId: 'w1' }))
}
const inbound = (phone: string | null, text: string) =>
  handleStayInbound(db as never, { accountId: 'a1', phone, text, requestUrl: REQUEST, now: NOW, transport: transport as never })

beforeEach(() => seed())

describe('parseInboundCommand', () => {
  it('reads READY and 1, 2, anything else', () => {
    expect(parseInboundCommand('READY')).toBe('ready')
    expect(parseInboundCommand('  ready! ')).toBe('ready')
    expect(parseInboundCommand('1')).toBe('other') // numbers belong to the menu now
    expect(parseInboundCommand('wifi')).toBe('access')
    expect(parseInboundCommand('help')).toBe('other')
    expect(parseInboundCommand('I am ready to go')).toBe('other')
    expect(parseInboundCommand('')).toBe('other')
  })
})

describe('registered guest', () => {
  it('READY records on-the-way and alerts owners and the caretaker, sending nothing', async () => {
    const r = await inbound('919000011111', 'READY')
    expect(r).toEqual({ registered: true, handled: true, suppressAutomation: false })
    expect(db.tables.stays[0].on_the_way_at).toBe(NOW.toISOString())
    expect(db.tables.notifications.map((n) => n.user_id).sort()).toEqual(['care', 'owner'])
    expect(transport).not.toHaveBeenCalled()
  })

  it('WIFI resends the access instructions when IDs are verified', async () => {
    const r = await inbound('919000011111', 'wifi')
    expect(r.handled).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][0].text).toContain('Code 1234')
    expect(transport.mock.calls[0][0].phone).toBe('919000011111')
  })

  it('WIFI sends nothing while IDs are unverified and tells the team', async () => {
    db.tables.stay_guests[0].id_verified_at = null
    await inbound('919000011111', 'wifi')
    expect(transport).not.toHaveBeenCalled()
    expect(db.tables.notifications[0].title).toMatch(/access details/)
  })

  it('anything else alerts the team, answers nothing and lets normal handling continue', async () => {
    const r = await inbound('919000011111', 'where is the parking?')
    expect(r).toEqual({ registered: true, handled: false, suppressAutomation: false })
    expect(transport).not.toHaveBeenCalled()
    expect(db.tables.notifications).toHaveLength(2)
  })

  it('a stay past checkout + 7 days is no longer registered', async () => {
    const r = await handleStayInbound(db as never, { accountId: 'a1', phone: '919000011111', text: 'READY', requestUrl: REQUEST, now: ist('2026-11-25 10:00'), transport: transport as never })
    expect(r.registered).toBe(false)
  })
})

describe('the guest menu', () => {
  beforeEach(() => {
    db.tables.conversations = [{ id: 'c1', account_id: 'a1', guest_menu_state: null, guest_menu_at: null }]
  })
  const say = (text: string, at: Date = NOW) =>
    handleStayInbound(db as never, { accountId: 'a1', phone: '919000011111', text, requestUrl: REQUEST, conversationId: 'c1', messageId: `M-${text}-${at.getTime()}`, now: at, transport: transport as never })
  const lastText = () => transport.mock.calls.at(-1)?.[0].text as string

  it.each(['hi', 'HELLO', 'Hey', 'hii', 'Good morning', 'menu'])('"%s" shows the menu and alerts nobody', async (hello) => {
    const r = await say(hello)
    expect(r.handled).toBe(true)
    expect(lastText()).toContain('1️⃣ Update ID / registration form')
    expect(lastText()).toContain('Connect with the caretaker')
    expect(lastText()).toContain('Food')
    expect(db.tables.conversations[0].guest_menu_state).toBe('main')
    expect(db.tables.notifications ?? []).toHaveLength(0)
  })

  it('a sentence is not a greeting', async () => {
    await say('hi, where is the parking?')
    expect(transport).not.toHaveBeenCalled()
  })

  it('1 sends the form link and the ID status', async () => {
    await say('hi')
    await say('1')
    expect(lastText()).toContain('https://villa.test/stay/abcdef0123456a')
    expect(lastText()).toContain('all IDs are approved')
    expect(db.tables.conversations[0].guest_menu_state).toBeNull()
  })

  it('2 sends the access details when IDs are approved', async () => {
    await say('hi')
    await say('2')
    expect(lastText()).toContain('Code 1234')
  })

  it('3 tells the caretaker and answers the guest, without a phone number', async () => {
    await say('hi')
    await say('3')
    expect(lastText()).toContain('caretaker has been told')
    expect(lastText()).not.toMatch(/\d{6,}/)
    expect((db.tables.notifications ?? []).length).toBeGreaterThan(0)
  })

  it('4 asks for the food request and the next message goes to the caretaker', async () => {
    await say('hi')
    await say('4')
    expect(lastText()).toContain('Food')
    expect(db.tables.conversations[0].guest_menu_state).toBe('food')
    await say('2 vegetarian thalis at 8 pm')
    expect(lastText()).toContain('passed your food request')
    expect(db.tables.notifications.some((n) => String(n.body).includes('Food request') && String(n.body).includes('thalis'))).toBe(true)
    expect(db.tables.conversations[0].guest_menu_state).toBeNull()
  })

  it('a bare number with no menu open shows the menu instead of guessing', async () => {
    await say('2')
    expect(lastText()).toContain('Reply with a number')
    expect(db.tables.notifications ?? []).toHaveLength(0)
  })

  it('a menu answer is only read for 30 minutes', async () => {
    await say('hi')
    await say('3', new Date(NOW.getTime() + 31 * 60_000))
    expect(lastText()).toContain('Reply with a number') // the menu again, not the caretaker
  })

  it('5 records on the way', async () => {
    await say('hi')
    await say('5')
    expect(db.tables.stays[0].on_the_way_at).not.toBeNull()
  })

  it('an unregistered number gets no menu', async () => {
    const r = await handleStayInbound(db as never, { accountId: 'a1', phone: '919555555555', text: 'hi', requestUrl: REQUEST, conversationId: 'c1', now: NOW, transport: transport as never })
    expect(r.registered).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('unregistered numbers', () => {
  it('READY from an unknown number triggers no stay logic and no reply', async () => {
    const r = await inbound('919555555555', 'READY')
    expect(r).toEqual({ registered: false, handled: false, suppressAutomation: true })
    expect(db.tables.stays[0].on_the_way_at).toBeNull()
    expect(db.tables.notifications ?? []).toHaveLength(0)
    expect(transport).not.toHaveBeenCalled()
  })

  it('a sender with no phone (username only) is not registered', async () => {
    const r = await inbound(null, '1')
    expect(r.registered).toBe(false)
    expect(r.suppressAutomation).toBe(true)
  })

  it('a stay without automation (paused) is treated as unregistered', async () => {
    db.tables.stays[0].automation_ready = false
    expect((await inbound('919000011111', 'READY')).registered).toBe(false)
  })

  it('an account that is not a villa account is left alone', async () => {
    seed({}, false)
    const r = await inbound('919555555555', 'hello')
    expect(r).toEqual({ registered: false, handled: false, suppressAutomation: false })
  })

  it('logs the ignored message with only the last 4 digits', async () => {
    await inbound('919555555555', 'READY')
    const l = db.tables.stay_message_log[0]
    expect(l).toMatchObject({ outcome: 'inbound_ignored', direction: 'in', phone_tail: '5555' })
    expect(JSON.stringify(l)).not.toContain('919555555555')
  })
})

describe('villaAllowsAutomation (upstream automations, flows, AI)', () => {
  it('allows registered numbers, blocks others, and ignores non-villa accounts', async () => {
    expect(await villaAllowsAutomation(db as never, 'a1', '919000011111', NOW)).toBe(true)
    expect(await villaAllowsAutomation(db as never, 'a1', '919555555555', NOW)).toBe(false)
    expect(await villaAllowsAutomation(db as never, 'a1', null, NOW)).toBe(false)
    seed({}, false)
    expect(await villaAllowsAutomation(db as never, 'a1', '919555555555', NOW)).toBe(true)
  })
})

describe('assertVillaSendAllowed (outbound guard for upstream bots)', () => {
  it('passes for a registered number', async () => {
    await expect(assertVillaSendAllowed(db as never, 'a1', '919000011111', 'flow')).resolves.toBeUndefined()
  })
  it('throws and logs blocked_not_registered for any other number', async () => {
    await expect(assertVillaSendAllowed(db as never, 'a1', '919555555555', 'automation')).rejects.toBeInstanceOf(VillaBlockedError)
    expect(db.tables.stay_message_log[0]).toMatchObject({ outcome: 'blocked_not_registered', message_key: 'upstream_automation', phone_tail: '5555' })
  })
  it('does nothing for a non-villa account', async () => {
    seed({}, false)
    await expect(assertVillaSendAllowed(db as never, 'a1', '919555555555', 'flow')).resolves.toBeUndefined()
  })
})
