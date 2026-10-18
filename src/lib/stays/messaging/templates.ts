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
    'Good morning {guest_first_name}! Here is how to get in: {access_instructions}\nIf you need anything, call the caretaker on {caretaker_phone}.',
  owner_alert: 'Registration still incomplete on arrival day: {stay_ref} ({guest_first_name}).',
  arrival_check:
    'Hello {guest_first_name}, we hope you have settled in. Is everything fine at the villa? Reply here or call {caretaker_phone} if you need anything.',
  checkout_reminder:
    'Hello {guest_first_name}, a reminder that check-out is tomorrow by {checkout_time}. Please call the caretaker on {caretaker_phone} about 20 minutes before you leave so we can inspect and return your keys. Any security deposit is processed within {refund_days} working days.',
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
