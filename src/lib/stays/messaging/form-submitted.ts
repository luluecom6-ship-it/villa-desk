import type { SupabaseClient } from '@supabase/supabase-js'
import { loadResponders, whatsappTeamAlert } from '../escalation/server'
import { notifyStaff } from './notify'
import { firstName } from './templates'

// When a guest submits (or re-submits) the registration form the team is told
// at once: a bell for the owner, admins and caretakers, and a WhatsApp from the
// villa number to every on-duty person who set an alert number. The alert has
// a stay reference and a first name only (never ID details). Best effort: a
// failed alert never fails the guest's submit.

export async function notifyFormSubmitted(
  db: SupabaseClient,
  args: { accountId: string; stayRef: string; guestName: string | null; siteUrl: string },
): Promise<void> {
  const who = args.guestName ? ` (${firstName(args.guestName)})` : ''
  const title = `Form submitted: ${args.stayRef}${who}`
  await notifyStaff(db, args.accountId, title, 'Open the stay, check the ID photos and approve or reject them.', { includeCaretakers: true })

  const people = (await loadResponders(db, args.accountId)).filter((r) => r.available && r.alertPhone)
  const text = `${title}\nPlease check the ID photos and approve: ${args.siteUrl}/stays`
  await Promise.all(people.map((r) => whatsappTeamAlert(db, args.accountId, r.alertPhone as string, text)))
}
