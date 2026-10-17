// ID file handling for the public guest form (PDR 6.3).
//
// Limits:
//   * Server: 8 MB per file, at most 2 files (front, back) per person, types
//     checked by CONTENT (magic bytes), not by file name or the browser's type.
//   * Request size: Vercel serverless functions reject request bodies over
//     4.5 MB, so one submit must stay under MAX_REQUEST_BYTES in total. The
//     client shrinks photos to ~0.5 MB; PDFs are capped lower than the PDR's
//     5 MB for that reason (MAX_PDF_BYTES). Raise these only after moving to
//     direct-to-storage uploads.

export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES_PER_GUEST = 2
/** Sum of all file bytes in one submit. Leaves headroom under Vercel's 4.5 MB body cap. */
export const MAX_REQUEST_BYTES = 4_000_000
export const MAX_PDF_BYTES = 3_000_000
export const IMAGE_MAX_EDGE = 1600
export const IMAGE_JPEG_QUALITY = 0.85

export type AllowedContentType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'

export interface SniffedType {
  contentType: AllowedContentType
  ext: 'jpg' | 'png' | 'webp' | 'pdf'
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v)

/** Identify an upload from its first bytes. Returns null for anything else. */
export function sniffFileType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', ext: 'jpg' }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', ext: 'png' }
  }
  // WebP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', ext: 'webp' }
  }
  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { contentType: 'application/pdf', ext: 'pdf' }
  return null
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer so the digest input is never a shared view.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Scale (width, height) down so the long edge is at most `max`, keeping the
 * aspect ratio. Never scales up. Sizes are whole pixels, at least 1.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (!(longEdge > max)) return { width, height }
  const scale = max / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export type FileProblem = 'tooLarge' | 'unsupportedType' | 'empty'

/** Server-side check of one uploaded file. */
export function checkUpload(bytes: Uint8Array): { ok: true; type: SniffedType } | { ok: false; problem: FileProblem } {
  if (bytes.byteLength === 0) return { ok: false, problem: 'empty' }
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, problem: 'tooLarge' }
  const type = sniffFileType(bytes)
  if (!type) return { ok: false, problem: 'unsupportedType' }
  return { ok: true, type }
}
