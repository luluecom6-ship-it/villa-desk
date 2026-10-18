import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { metaTransport, type StayTransport } from './send'

// Which WhatsApp channel carries a stay message (PDR 8.1).
//   1. The channel the guest last wrote on / we last wrote on (conversations.channel).
//   2. Otherwise the property's default (properties.default_channel; Evolution by default).
// Fail-closed: if Evolution is chosen and not set up, the send fails with a
// clear code. It never falls back to the other channel on its own.

export type Channel = 'meta' | 'evolution'

export function pickChannel(args: { conversationChannel?: string | null; propertyDefault?: string | null }): Channel {
  if (args.conversationChannel === 'evolution' || args.conversationChannel === 'meta') return args.conversationChannel
  return args.propertyDefault === 'meta' ? 'meta' : 'evolution'
}

export async function resolveStayChannel(db: SupabaseClient, accountId: string, phone: string): Promise<Channel> {
  const { data: prop } = await db.from('properties').select('default_channel').eq('account_id', accountId).limit(1)
  const propertyDefault = (prop?.[0] as { default_channel?: string } | undefined)?.default_channel ?? null

  let conversationChannel: string | null = null
  const contact = await findExistingContact(db, accountId, phone)
  if (contact) {
    const { data: conv } = await db
      .from('conversations')
      .select('channel')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: true })
      .limit(1)
    conversationChannel = (conv?.[0] as { channel?: string | null } | undefined)?.channel ?? null
  }
  return pickChannel({ conversationChannel, propertyDefault })
}

export async function defaultStayTransport(db: SupabaseClient, accountId: string, phone: string): Promise<StayTransport> {
  const channel = await resolveStayChannel(db, accountId, phone)
  if (channel === 'meta') return metaTransport
  const { evolutionStayTransport } = await import('@/lib/evolution/transport')
  return evolutionStayTransport
}
