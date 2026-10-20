/**
 * Agent relay: pure rules (tested in logic.test.ts).
 *
 * Guests write to the villa WhatsApp number. The message is copied to the agent
 * who has the chat, on the agent's own WhatsApp. The agent swipe-replies (or starts
 * the message with the chat number, e.g. "#482") and the answer goes to the guest
 * from the villa number. Pattern ported from Jwacrm's agent relay.
 */

export type AgentCommand =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'close'; code: number | null }
  | { kind: 'info'; code: number | null }
  | { kind: 'transfer'; to: string; code: number | null }
  | { kind: 'approve'; code: number | null }
  | { kind: 'decline'; reason: string; code: number | null }
  | { kind: 'reply'; text: string; code: number | null }

const CODE = /#(\d{2,9})\b/

/** "#482 thanks" -> { code: 482, rest: "thanks" } */
export function splitCode(text: string): { code: number | null; rest: string } {
  const m = CODE.exec(text)
  if (!m) return { code: null, rest: text.trim() }
  return { code: Number(m[1]), rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() }
}

/** What an agent's message means. Anything that is not a /command is a reply to the guest. */
export function parseAgentMessage(raw: string | null | undefined): AgentCommand {
  const text = (raw ?? '').trim()
  const cmd = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(text)
  if (!cmd) {
    // Only a leading "#482" picks the chat; a "#" inside the reply stays as typed.
    const leading = /^#\d{2,9}\b/.test(text)
    const { code, rest } = splitCode(text)
    return { kind: 'reply', text: leading ? rest : text, code: leading ? code : null }
  }
  const { code, rest } = splitCode(cmd[2] ?? '')
  switch (cmd[1].toLowerCase()) {
    case 'on':
    case 'online':
    case 'start':
      return { kind: 'on' }
    case 'off':
    case 'offline':
    case 'away':
      return { kind: 'off' }
    case 'close':
    case 'done':
      return { kind: 'close', code }
    case 'info':
      return { kind: 'info', code }
    case 'list':
    case 'chats':
      return { kind: 'list' }
    case 'ok':
    case 'yes':
    case 'approve':
    case 'confirm':
      return { kind: 'approve', code }
    case 'no':
    case 'decline':
    case 'reject':
      return { kind: 'decline', reason: rest, code }
    case 'transfer':
    case 'move':
      return { kind: 'transfer', to: rest, code }
    default:
      return { kind: 'help' }
  }
}

/**
 * A plain "ok" / "yes" / "👍" (or a bare "no") written to a guest who has a food order waiting is an answer to
 * that order, not a message for the guest. The caller checks that an order is really waiting.
 */
export function orderAnswerFromReply(raw: string | null | undefined): { kind: 'approve' } | { kind: 'decline'; reason: string } | null {
  const text = (raw ?? '').trim()
  if (/^(ok|okay|yes|y|confirm|confirmed|approve|approved|done|accept|accepted|👍|✅)[\s.!]*$/iu.test(text)) return { kind: 'approve' }
  if (/^(no|decline|declined|reject|rejected|sorry|❌)[\s.!]*$/iu.test(text)) return { kind: 'decline', reason: '' }
  const withReason = /^(decline|reject)\b[\s:,-]*([\s\S]+)$/iu.exec(text)
  if (withReason) return { kind: 'decline', reason: withReason[2].trim() }
  return null
}

export const HELP_TEXT = [
  '*How to answer guests*',
  "Swipe-reply to a guest's message (or start with its number, e.g. #482) and type your answer. It goes to the guest from the villa number.",
  '',
  'ok (or /ok)  confirm the guest\'s food order',
  '/no reason  (or just no) decline the food order (the reason is sent to the guest)',
  '/close  finish the chat (stop reminders)',
  '/transfer Sara  give the chat to another person',
  '/info  guest and stay details',
  '/list  your open chats',
  '/off  stop receiving chats  |  /on  start again',
].join('\n')

/** "9665•••••300" */
export function maskPhone(digits: string): string {
  const d = (digits ?? '').replace(/\D/g, '')
  return d.length <= 7 ? d : `${d.slice(0, 4)}${'•'.repeat(Math.max(0, d.length - 7))}${d.slice(-3)}`
}

export interface GuestCard {
  name: string | null
  phoneDigits: string
  stayRef?: string | null
  /** e.g. "12 Nov to 14 Nov" */
  stayDates?: string | null
}

/** What the agent sees for a guest message. `intro` = the first message of a chat they just received. */
export function forwardText(args: {
  code: number
  card: GuestCard
  body: string | null
  intro: boolean
  /** Set when this chat came from someone who did not answer in time. */
  movedFrom?: string | null
  /** Earlier lines of the chat, oldest first, e.g. "Guest: ..." / "Us: ..." (context for a chat the agent just received). */
  history?: string[]
}): string {
  const who = args.card.name?.trim() || 'Guest'
  const quote = args.body?.trim() ? `“${args.body.trim()}”` : ''
  if (!args.intro) return [`*#${args.code} ${who}:*`, quote].filter(Boolean).join(' ')
  const stay = [args.card.stayRef, args.card.stayDates].filter(Boolean).join(' · ')
  return [
    `🟢 *#${args.code} · ${who}* (${maskPhone(args.card.phoneDigits)})`,
    stay || null,
    args.movedFrom ? `↪️ Moved from ${args.movedFrom} (no reply in time)` : null,
    args.history && args.history.length > 0 ? `\n_Earlier:_\n${args.history.join('\n')}` : null,
    '',
    quote || null,
    '',
    '_Swipe-reply to answer · /close · /transfer name · /info_',
  ]
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
