// The guest's WhatsApp menu (pure rules). A registered guest writes "hi" and gets numbered
// choices; the next reply is read as a choice for a short while only. Text lives here so it is
// easy to change; no caretaker phone number is ever shown to a guest (option 3 connects them).

export type MenuChoice = 'form' | 'access' | 'caretaker' | 'food' | 'ready'

/** A menu answer counts for this long after the menu (or the food question) was sent. */
export const MENU_TTL_MS = 30 * 60_000

const GREETING_WORDS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'helo', 'hlo', 'hey', 'heyy', 'hola', 'menu', 'start', 'namaste', 'namaskar', 'salam', 'salaam', 'assalamualaikum', 'assalamu', 'good', 'greetings', 'yo', 'hai',
])

/** "hi", "Hello", "HEY there", "good morning", "menu" in any case. Not a sentence with a request in it. */
export function isGreeting(text: string): boolean {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0 || words.length > 3) return false
  return GREETING_WORDS.has(words[0])
}

export const MENU_OPTIONS: { choice: MenuChoice; label: string; keywords: string[] }[] = [
  { choice: 'form', label: 'Update ID / registration form', keywords: ['form', 'id', 'update id', 'registration', 'document', 'documents'] },
  { choice: 'access', label: 'WiFi and check-in details', keywords: ['wifi', 'wi-fi', 'access', 'lock', 'key', 'checkin', 'check in', 'check-in', 'entry'] },
  { choice: 'caretaker', label: 'Connect with the caretaker', keywords: ['caretaker', 'care taker', 'help', 'agent', 'support', 'talk', 'call'] },
  { choice: 'food', label: 'Food', keywords: ['food', 'meal', 'meals', 'breakfast', 'lunch', 'dinner'] },
  { choice: 'ready', label: "I'm on my way", keywords: ['ready', 'on the way', 'on my way', 'omw'] },
]

const norm = (t: string) => (t ?? '').trim().toLowerCase().replace(/[.!?\s]+$/g, '')

/** "3" or a keyword -> the choice. Null when the text is neither. */
export function parseMenuChoice(text: string): MenuChoice | null {
  const t = norm(text)
  if (!t) return null
  const n = /^([1-5])[\s.)]*$/.exec(t)
  if (n) return MENU_OPTIONS[Number(n[1]) - 1].choice
  for (const o of MENU_OPTIONS) if (o.keywords.includes(t)) return o.choice
  return null
}

/** A bare number 1 to 5 (so we can show the menu when it arrives with no menu open). */
export const isMenuNumber = (text: string): boolean => /^[1-5][\s.)]*$/.test(norm(text))

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']

export function menuText(firstName: string, villa: string): string {
  const lines = MENU_OPTIONS.map((o, i) => `${NUM[i]} ${o.label}`)
  return [`Hello ${firstName || 'there'}! 👋 Welcome to ${villa || 'the villa'}.`, 'How can we help? Reply with a number:', '', ...lines].join('\n')
}

export const FOOD_PROMPT =
  '🍽️ Food: tell us what you would like (dishes, how many people, and the time) and the caretaker will confirm with you here. Please type your request now.'
export const FOOD_THANKS = 'Thank you! We have passed your food request to the caretaker. They will confirm with you shortly.'
export const CARETAKER_REPLY = 'Done ✅ The caretaker has been told and will reply here shortly. You can type your message now.'

export const menuIsFresh = (at: string | null | undefined, now: Date): boolean => !!at && now.getTime() - new Date(at).getTime() <= MENU_TTL_MS
