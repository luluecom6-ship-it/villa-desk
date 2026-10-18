import type { SupabaseClient } from '@supabase/supabase-js'
import { mirrorInboundMedia, normalizeMimeType } from '@/lib/whatsapp/mirror-inbound-media'
import { getBase64FromMedia } from './client'
import { connFromRow, loadEvolutionConfig } from './server'
import type { NormalizedMessage } from './normalize'

// Photos, voice notes, videos and files that arrive on the villa number are copied
// into the same private-by-path `chat-media` bucket the inbox already uses, so they
// show in the inbox, can be sent on to an agent, and do not expire.

export const MEDIA_TYPES: NormalizedMessage['type'][] = ['image', 'video', 'document', 'audio', 'sticker']
export const hasMediaType = (t: NormalizedMessage['type']) => MEDIA_TYPES.includes(t)

/** inbox kind for a MIME type: image | video | audio | document */
export function kindForMime(mime: string | null | undefined): 'image' | 'video' | 'audio' | 'document' {
  const top = (mime ?? '').split('/')[0]
  return top === 'image' || top === 'video' || top === 'audio' ? top : 'document'
}

/** Download the media (base64 from the webhook, else asked from Evolution) and store it. Best effort: null on any failure. */
export async function storeEvolutionMedia(
  db: SupabaseClient,
  storage: Parameters<typeof mirrorInboundMedia>[0]['storage'],
  accountId: string,
  n: NormalizedMessage,
): Promise<{ url: string | null; mime: string | null }> {
  let b64 = n.media?.base64 ?? null
  let mime = n.media?.mimetype ?? null
  let fileName = n.media?.fileName ?? null
  if (!b64) {
    try {
      const cfg = await loadEvolutionConfig(accountId, db)
      if (cfg) {
        const r = await getBase64FromMedia(connFromRow(cfg), n.id)
        b64 = r.base64
        mime = mime ?? r.mimetype
        fileName = fileName ?? r.fileName
      }
    } catch (e) {
      console.warn('[evolution] media download failed:', (e as { status?: number })?.status ?? 'error')
    }
  }
  if (!b64) return { url: null, mime: normalizeMimeType(mime) }
  const raw = b64.startsWith('data:') && b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const buffer = Buffer.from(raw, 'base64')
  const url = await mirrorInboundMedia({
    storage,
    accountId,
    mediaId: n.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'evo',
    downloadUrl: '',
    accessToken: '',
    mimeType: mime,
    fileSize: buffer.byteLength,
    fileName,
    messageTimestamp: n.timestamp,
    download: async () => ({ buffer, contentType: normalizeMimeType(mime) ?? 'application/octet-stream' }),
  })
  return { url, mime: normalizeMimeType(mime) }
}
