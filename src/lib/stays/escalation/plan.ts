// Who is told about a guest message, and when it moves on. Pure functions.
//
// Order: available agents (caretakers) first, one after another; when none is
// left, the owner; if the account has no owner, admins. An agent who switched
// "off duty" is skipped. The owner is the last resort and is always included.

export interface Responder {
  userId: string
  role: 'owner' | 'admin' | 'agent' | string
  available: boolean
  alertPhone: string | null
  createdAt: string
  /** Display name (profiles.full_name); used by /transfer. */
  name?: string | null
}

export function buildChain(members: Responder[]): Responder[] {
  const byAge = (a: Responder, b: Responder) => a.createdAt.localeCompare(b.createdAt)
  const agents = members.filter((m) => m.role === 'agent' && m.available).sort(byAge)
  const owners = members.filter((m) => m.role === 'owner').sort(byAge)
  const admins = members.filter((m) => m.role === 'admin').sort(byAge)
  return [...agents, ...(owners.length > 0 ? owners : admins)]
}

/** The next person to tell: first in the chain not yet told. */
export function nextResponder(chain: Responder[], notified: string[]): Responder | null {
  return chain.find((m) => !notified.includes(m.userId)) ?? null
}

export type EscalationAction = 'resolve_replied' | 'wait' | 'advance' | 'exhausted'

export function decide(args: {
  replied: boolean
  dueAt: Date
  now: Date
  chain: Responder[]
  notified: string[]
}): EscalationAction {
  if (args.replied) return 'resolve_replied'
  if (args.now < args.dueAt) return 'wait'
  return nextResponder(args.chain, args.notified) ? 'advance' : 'exhausted'
}
