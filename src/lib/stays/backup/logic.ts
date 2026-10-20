// Drive backup and archive rules (PDR 13.4), pure and tested.

export const DEFAULT_STORAGE_LIMIT_BYTES = 1_073_741_824 // Supabase free plan: 1 GB of files
export const AMBER_AT = 0.7
export const RED_AT = 0.9
export const ARCHIVE_TARGET = 0.5
export const ARCHIVE_MIN_AGE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export type MeterLevel = 'ok' | 'amber' | 'red'

export function storageLimit(env: string | undefined): number {
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STORAGE_LIMIT_BYTES
}

export function meter(usedBytes: number, limitBytes: number) {
  const fraction = limitBytes > 0 ? usedBytes / limitBytes : 0
  const level: MeterLevel = fraction >= RED_AT ? 'red' : fraction >= AMBER_AT ? 'amber' : 'ok'
  return { usedBytes, limitBytes, fraction, percent: Math.round(fraction * 1000) / 10, level }
}

export interface ArchiveCandidate {
  id: string
  stayRef: string
  checkoutAt: string
  sizeBytes: number
}

/**
 * The archive proposal: at 70% or more, the oldest verified files of checked-out stays older
 * than 90 days, oldest first, until the projected usage is about 50%. Below 70% nothing is
 * proposed. The caller passes only verified, not-yet-archived files of checked-out stays.
 */
export function proposeArchive(
  candidates: ArchiveCandidate[],
  usedBytes: number,
  limitBytes: number,
  now: Date = new Date(),
): { files: ArchiveCandidate[]; freedBytes: number; projectedFraction: number } {
  const m = meter(usedBytes, limitBytes)
  if (m.fraction < AMBER_AT) return { files: [], freedBytes: 0, projectedFraction: m.fraction }
  const cutoff = now.getTime() - ARCHIVE_MIN_AGE_DAYS * DAY_MS
  const eligible = candidates
    .filter((c) => new Date(c.checkoutAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.checkoutAt).getTime() - new Date(b.checkoutAt).getTime() || a.id.localeCompare(b.id))
  const files: ArchiveCandidate[] = []
  let freed = 0
  for (const c of eligible) {
    if ((usedBytes - freed) / limitBytes <= ARCHIVE_TARGET) break
    files.push(c)
    freed += c.sizeBytes
  }
  return { files, freedBytes: freed, projectedFraction: limitBytes > 0 ? (usedBytes - freed) / limitBytes : 0 }
}

/** A file is backed up only when the Drive copy has the same size and SHA-256. */
export function copyMatches(
  stored: { size_bytes: number; sha256: string },
  drive: { size: unknown; sha256: unknown },
): boolean {
  return Number(drive.size) === Number(stored.size_bytes) && String(drive.sha256 ?? '').toLowerCase() === stored.sha256.toLowerCase()
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }

/** A readable Drive file name. No guest name or ID number: stay ref, role, side, short id. */
export function driveFileName(d: { stayRef: string; role: string; side: string; id: string; contentType: string }): string {
  return `${d.stayRef}_${d.role}_${d.side}_${d.id.slice(0, 8)}.${EXT[d.contentType] ?? 'bin'}`
}
