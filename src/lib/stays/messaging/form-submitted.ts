import type { SupabaseClient } from '@supabase/supabase-js'
import { loadResponders, whatsappTeamAlert } from '../escalation/server'
import { notifyStaff } from './notify'
import { firstName } from './templates'

// The team is told when something needs them:
//   * a registration is created      -> they know a guest is coming and a form link went out
//   * a guest submits (or re-submits) the form -> check the ID photos and approve or reject
// Each gets a bell for the owner, admins and caretakers, plus a WhatsApp from the villa
// number to every on-duty person who set a WhatsApp number. The alert has a stay reference
// and a first name only (never ID details). Best effort: a failed alert never fails the
// action that caused it.

async function alertTeam(
  db: SupabaseClient,
  args: { accountId: string; title: string; body: string; whatsapp: string; exceptUserId?: string | null },
): Promise<void> {
  if (args.exceptUserId) {
    // The person who just did it does not need telling: bell and WhatsApp go to everyone else.
    const people = await loadResponders(db, args.accountId)
    const others = people.filter((p) => p.userId !== args.exceptUserId && ['owner', 'admin', 'agent'].includes(p.role))
    if (others.length > 0) {
      await db.from('notifications').insert(
        others.map((p) => ({ account_id: args.accountId, user_id: p.userId, type: 'stay_alert', title: args.title.slice(0, 200), body: args.body.slice(0, 500) })),
      )
    }
    await Promise.all(others.filter((r) => r.available && r.alertPhone).map((r) => whatsappTeamAlert(db, args.accountId, r.alertPhone as string, args.whatsapp)))
    return
  }
  await notifyStaff(db, args.accountId, args.title, args.body, { includeCaretakers: true })
  const people = (await loadResponders(db, args.accountId)).filter((r) => r.available && r.alertPhone)
  await Promise.all(people.map((r) => whatsappTeamAlert(db, args.accountId, r.alertPhone as string, args.whatsapp)))
}

export async function notifyFormSubmitted(
  db: SupabaseClient,
  args: { accountId: string; stayRef: string; guestName: string | null; siteUrl: string },
): Promise<void> {
  const who = args.guestName ? ` (${firstName(args.guestName)})` : ''
  const title = `Form submitted: ${args.stayRef}${who}`
  await alertTeam(db, {
    accountId: args.accountId,
    title,
    body: 'Open the stay, check the ID photos and approve or reject them.',
    whatsapp: `${title}\nPlease check the ID photos and approve: ${args.siteUrl}/stays`,
  })
}

export async function notifyStayCreated(
  db: SupabaseClient,
  args: { accountId: string; stayRef: string; guestName: string | null; checkin: string | null; formSent: boolean; createdBy: string | null; siteUrl: string },
): Promise<void> {
  const who = args.guestName ? ` (${firstName(args.guestName)})` : ''
  const day = args.checkin ? new Date(args.checkin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : null
  const title = `New registration: ${args.stayRef}${who}`
  const detail = [day ? `Check-in ${day}.` : null, args.formSent ? 'The form link is being sent to the guest.' : 'No mobile number yet: add it so the form link can be sent.'].filter(Boolean).join(' ')
  await alertTeam(db, {
    accountId: args.accountId,
    title,
    body: detail,
    whatsapp: `${title}\n${detail}\n${args.siteUrl}/stays`,
    exceptUserId: args.createdBy,
  })
}
