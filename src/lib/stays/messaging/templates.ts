import type { MessageKey } from './schedule'

// Built-in wording for the eight guest messages (PDR 7.1) plus the staff
// alerts. An admin can override any of them in stay_message_templates.
// Variables use {name}; unknown variables are left visible so a typo shows up
// in a test message instead of silently vanishing.

export const TEMPLATE_VARIABLES = [
  'guest_first_name',
  'stay_ref',
  'form_url',
  'property_name',
  'address',
  'map_url',
  'directions',
  'checkin_time',
  'checkout_time',
  'access_instructions',
  'caretaker_phone',
  'review_url',
  'refund_days',
] as const
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

export const DEFAULT_TEMPLATES: Record<MessageKey, string> = {
  form_link:
    'Hello {guest_first_name}, welcome to {property_name}! Your stay reference is {stay_ref}. Please fill in your guest registration before you arrive: {form_url}',
  form_reminder_3d:
    'Hello {guest_first_name}, a reminder to complete your guest registration for {stay_ref} (3 days to go): {form_url}',
  form_reminder_2d:
    'Hello {guest_first_name}, your guest registration for {stay_ref} is still pending (2 days to go): {form_url}',
  form_reminder_1d:
    'Hello {guest_first_name}, you arrive tomorrow and your registration for {stay_ref} is still pending. It takes 2 minutes: {form_url}',
  id_alert_staff: 'IDs to approve before arrival: {stay_ref} ({guest_first_name}). Open the Stays page to review.',
  arrival_info:
    'Hello {guest_first_name}, we look forward to hosting you tomorrow. Address: {address}\nMap: {map_url}\n{directions}\nCheck-in from {checkin_time}. When you set off, reply READY.',
  access_details:
    'Good morning {guest_first_name}! Here is how to get in: {access_instructions}\nIf you need anything, reply *hi* here to reach the caretaker.',
  owner_alert: 'Registration still incomplete on arrival day: {stay_ref} ({guest_first_name}).',
  arrival_check:
    'Hello {guest_first_name}, we hope you have settled in. Is everything fine at the villa? Reply here, or write *hi* for options, if you need anything.',
  checkout_reminder:
    'Hello {guest_first_name}, a reminder that check-out is tomorrow by {checkout_time}. Please tell us here (write *hi* and choose the caretaker) about 20 minutes before you leave so we can inspect and return your keys. Any security deposit is processed within {refund_days} working days.',
  review_request:
    'Thank you for staying with us, {guest_first_name}! We would love your feedback: {review_url}',
}

/** Order of variables passed to a Meta template as {{1}}, {{2}}, ... */
export const META_TEMPLATE_PARAMS: Record<MessageKey, TemplateVariable[]> = {
  form_link: ['guest_first_name', 'property_name', 'stay_ref', 'form_url'],
  form_reminder_3d: ['guest_first_name', 'stay_ref', 'form_url'],
  form_reminder_2d: ['guest_first_name', 'stay_ref', 'form_url'],
  form_reminder_1d: ['guest_first_name', 'stay_ref', 'form_url'],
  id_alert_staff: [],
  arrival_info: ['guest_first_name', 'address', 'map_url', 'directions', 'checkin_time'],
  access_details: ['guest_first_name', 'access_instructions', 'caretaker_phone'],
  owner_alert: [],
  arrival_check: ['guest_first_name', 'caretaker_phone'],
  checkout_reminder: ['guest_first_name', 'checkout_time', 'caretaker_phone', 'refund_days'],
  review_request: ['guest_first_name', 'review_url'],
}

export type TemplateValues = Partial<Record<TemplateVariable, string>>

/** Fill {variables}. Empty values become empty text; unknown names stay as written. */
export function renderTemplate(body: string, values: TemplateValues): string {
  return body
    .replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
      if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return whole
      return values[name as TemplateVariable] ?? ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Variables a body uses that are not in the allowed list (for the editor). */
export function unknownVariables(body: string): string[] {
  const found = new Set<string>()
  for (const m of body.matchAll(/\{([a-z_]+)\}/g)) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(m[1])) found.add(m[1])
  }
  return [...found]
}

/** "Asha Rao" -> "Asha". */
export function firstName(full: string): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? ''
}

/** Variables a message must keep, or it is useless to the guest. */
export const REQUIRED_VARIABLES: Partial<Record<MessageKey, TemplateVariable>> = {
  form_link: 'form_url',
  form_reminder_3d: 'form_url',
  form_reminder_2d: 'form_url',
  form_reminder_1d: 'form_url',
  access_details: 'access_instructions',
  review_request: 'review_url',
}

export type TemplateCheck = { ok: true; body: string } | { ok: false; error: 'empty' | 'tooLong' | 'unknownVariable' | 'missingVariable'; detail?: string }

/** Validate wording an admin typed in the editor. */
export function checkTemplateBody(key: MessageKey, raw: unknown): TemplateCheck {
  const body = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  if (body.length === 0) return { ok: false, error: 'empty' }
  if (body.length > 2000) return { ok: false, error: 'tooLong' }
  const unknown = unknownVariables(body)
  if (unknown.length > 0) return { ok: false, error: 'unknownVariable', detail: unknown.map((u) => `{${u}}`).join(', ') }
  const need = REQUIRED_VARIABLES[key]
  if (need && !body.includes(`{${need}}`)) return { ok: false, error: 'missingVariable', detail: `{${need}}` }
  return { ok: true, body }
}

/** Example values for the editor's live preview. */
export const SAMPLE_VALUES: TemplateValues = {
  guest_first_name: 'Asha',
  stay_ref: 'MS-2026-001',
  form_url: 'https://your-app.vercel.app/stay/abc123',
  property_name: 'Mahinoor Stays',
  address: '12 Lake View Road, Bengaluru',
  map_url: 'https://maps.app.goo.gl/example',
  directions: 'Second gate on the left.',
  checkin_time: '2:00 PM',
  checkout_time: '11:00 AM',
  access_instructions: 'WiFi: Villa-Guest / password 12345. Lockbox code 4821.',
  caretaker_phone: '+91 98xxxxxx00',
  review_url: 'https://g.page/r/example',
  refund_days: '7',
}
