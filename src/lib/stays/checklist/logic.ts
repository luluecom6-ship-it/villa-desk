// Arrival checklist, check-out inspection and damage reports (PDR 10). Pure, tested.

export type ItemType = 'check' | 'reading'
export interface ChecklistItem { key: string; section: string; label: string; type: ItemType }
export type AnswerStatus = 'ok' | 'issue'
export interface Answer { status?: AnswerStatus | null; note?: string; reading?: number | null }
export type Answers = Record<string, Answer>
export const RUN_KINDS = ['arrival', 'checkout'] as const
export type RunKind = (typeof RUN_KINDS)[number]
export const DAMAGE_STATUSES = ['open', 'discussed', 'settled', 'waived'] as const
export type DamageStatus = (typeof DAMAGE_STATUSES)[number]
export const MAX_ITEMS = 150
export const MAX_PHOTOS_PER_ITEM = 5

export const isRunKind = (v: unknown): v is RunKind => RUN_KINDS.includes(v as RunKind)

/** A starting list for a 3BHK villa. The owner edits it in Settings. */
export const DEFAULT_ITEMS: ChecklistItem[] = [
  ...['Living room', 'Dining area', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Kitchen', 'Bathroom 1', 'Bathroom 2', 'Bathroom 3', 'Balcony / garden'].map((label) => ({ key: slug(label), section: 'Rooms', label: `${label} clean and tidy`, type: 'check' as const })),
  ...['Air conditioners', 'TV and remote', 'Refrigerator', 'Geyser / hot water', 'WiFi router', 'Washing machine', 'Lights and fans', 'Door locks and keys'].map((label) => ({ key: slug(label), section: 'Appliances', label, type: 'check' as const })),
  { key: 'electricity-meter', section: 'Meters', label: 'Electricity meter reading', type: 'reading' },
  { key: 'water-meter', section: 'Meters', label: 'Water meter reading', type: 'reading' },
]

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'
}

export type ItemsParse = { ok: true; items: ChecklistItem[] } | { ok: false; error: string }

/** Validate the template the owner edits. Keys stay stable once set; new items get a unique slug. */
export function parseItems(raw: unknown): ItemsParse {
  if (!Array.isArray(raw)) return { ok: false, error: 'items' }
  if (raw.length === 0) return { ok: false, error: 'empty' }
  if (raw.length > MAX_ITEMS) return { ok: false, error: 'tooMany' }
  const seen = new Set<string>()
  const items: ChecklistItem[] = []
  for (const r of raw) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const label = String(o.label ?? '').trim().slice(0, 120)
    const section = String(o.section ?? '').trim().slice(0, 60)
    const type: ItemType = o.type === 'reading' ? 'reading' : 'check'
    if (label.length < 2 || section.length < 1) return { ok: false, error: 'blank' }
    let key = typeof o.key === 'string' && /^[a-z0-9-]{1,40}$/.test(o.key) ? o.key : slug(label)
    for (let i = 2; seen.has(key); i++) key = `${slug(label)}-${i}`
    seen.add(key)
    items.push({ key, section, label, type })
  }
  return { ok: true, items }
}

export type AnswerParse = { ok: true; value: Answer } | { ok: false; error: string }

export function parseAnswer(item: ChecklistItem, raw: unknown): AnswerParse {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const note = String(o.note ?? '').trim().slice(0, 300)
  if (item.type === 'reading') {
    if (o.reading === null || o.reading === '' || o.reading === undefined) return { ok: true, value: { reading: null, ...(note ? { note } : {}) } }
    const n = Number(o.reading)
    if (!Number.isFinite(n) || n < 0 || n > 1e9) return { ok: false, error: 'reading' }
    return { ok: true, value: { reading: Math.round(n * 100) / 100, ...(note ? { note } : {}) } }
  }
  const status = o.status
  if (status !== 'ok' && status !== 'issue' && status !== null && status !== undefined) return { ok: false, error: 'status' }
  if (status === 'issue' && note.length < 3) return { ok: false, error: 'issueNeedsNote' }
  return { ok: true, value: { status: (status ?? null) as AnswerStatus | null, ...(note ? { note } : {}) } }
}

export const isAnswered = (item: ChecklistItem, a: Answer | undefined) =>
  item.type === 'reading' ? typeof a?.reading === 'number' : a?.status === 'ok' || a?.status === 'issue'

/** Items still without an answer: a run can be completed only when this is empty. */
export function unanswered(items: ChecklistItem[], answers: Answers): ChecklistItem[] {
  return items.filter((i) => !isAnswered(i, answers[i.key]))
}

export interface Difference { key: string; label: string; section: string; kind: 'new_issue' | 'reading_dropped' | 'usage'; arrival?: number; checkout?: number; note?: string }

/**
 * Check-out versus arrival (PDR 10): what changed. A new issue = fine on arrival, an issue at check-out.
 * Readings: usage = check-out minus arrival; a lower reading at check-out is flagged as suspicious.
 */
export function diffRuns(items: ChecklistItem[], arrival: Answers, checkout: Answers): Difference[] {
  const out: Difference[] = []
  for (const it of items) {
    const a = arrival[it.key], c = checkout[it.key]
    if (!a || !c) continue
    if (it.type === 'check') {
      if (a.status !== 'issue' && c.status === 'issue') out.push({ key: it.key, label: it.label, section: it.section, kind: 'new_issue', note: c.note })
    } else if (typeof a.reading === 'number' && typeof c.reading === 'number') {
      out.push({ key: it.key, label: it.label, section: it.section, kind: c.reading < a.reading ? 'reading_dropped' : 'usage', arrival: a.reading, checkout: c.reading })
    }
  }
  return out
}

export function parseDamage(raw: unknown, canSetCost: boolean): { ok: true; value: { title: string; description: string | null; estimated_cost: number | null; item_key: string | null } } | { ok: false; error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const title = String(o.title ?? '').trim().slice(0, 120)
  if (title.length < 3) return { ok: false, error: 'title' }
  const description = String(o.description ?? '').trim().slice(0, 1000) || null
  let cost: number | null = null
  if (canSetCost && o.estimated_cost !== undefined && o.estimated_cost !== null && o.estimated_cost !== '') {
    const n = Number(o.estimated_cost)
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return { ok: false, error: 'cost' }
    cost = Math.round(n * 100) / 100
  }
  const item_key = typeof o.item_key === 'string' && /^[a-z0-9-]{1,40}$/.test(o.item_key) ? o.item_key : null
  return { ok: true, value: { title, description, estimated_cost: cost, item_key } }
}

/** Reason text written to the deposit when a damage cost is applied to it. */
export const deductionReason = (existing: string | null | undefined, reportNo: number, title: string) => {
  const line = `Damage #${reportNo}: ${title}`
  return [existing?.trim(), line].filter(Boolean).join('; ').slice(0, 300)
}
