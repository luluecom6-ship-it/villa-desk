import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const m = vi.hoisted(() => ({ meta: vi.fn(), staff: vi.fn() }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: m.meta, sendTemplateMessage: m.meta, sendMediaMessage: m.meta,
  sendInteractiveButtons: m.meta, sendInteractiveList: m.meta,
}));
vi.mock('@/lib/evolution/transport', () => ({ sendStaffViaEvolution: m.staff }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({}) }) }) }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: 'a' } }) }) }) }) }),
}));

import { sendMessageToConversation, SendMessageError } from './send-message';

function db(channel: string | null, config: unknown, captured: { message?: Record<string, unknown> }): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b,
        insert: (row: Record<string, unknown>) => { if (table === 'messages') captured.message = row; return b; },
        update: () => b,
        single: async () => {
          if (table === 'conversations') return { data: { id: 'cv-1', channel, contact: { id: 'ct-1', phone: '+919876543210' } }, error: null };
          if (table === 'whatsapp_config') return { data: config, error: config ? null : { code: 'PGRST116' } };
          if (table === 'messages') return { data: { id: 'msg-1' }, error: null };
          return { data: null, error: null };
        },
        then: (r: (v: { data: unknown[]; error: null }) => unknown) => r({ data: [], error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => { vi.clearAllMocks(); m.staff.mockResolvedValue('WA-EVO-1'); });

describe('inbox send on the WhatsApp app number (Evolution)', () => {
  it('a chat on the evolution channel never touches Meta, even with no Meta config', async () => {
    const captured: { message?: Record<string, unknown> } = {};
    const r = await sendMessageToConversation(db('evolution', null, captured), 'a', { conversationId: 'cv-1', messageType: 'text', contentText: 'Hello' });
    expect(r.whatsappMessageId).toBe('WA-EVO-1');
    expect(m.meta).not.toHaveBeenCalled();
    expect(m.staff).toHaveBeenCalledWith(expect.anything(), 'a', expect.objectContaining({ phone: '919876543210', text: 'Hello' }));
    expect(captured.message).toMatchObject({ message_id: 'WA-EVO-1', content_text: 'Hello', sender_type: 'agent' });
  });

  it('a chat with no channel and no Meta config uses Evolution when it is linked', async () => {
    const captured: { message?: Record<string, unknown> } = {};
    await sendMessageToConversation(db(null, null, captured), 'a', { conversationId: 'cv-1', messageType: 'text', contentText: 'Hi' });
    expect(m.staff).toHaveBeenCalled();
  });

  it('a transport failure is reported with its code, nothing is stored', async () => {
    m.staff.mockRejectedValue(Object.assign(new Error('x'), { code: 'evolution_paused' }));
    const captured: { message?: Record<string, unknown> } = {};
    await expect(sendMessageToConversation(db('evolution', null, captured), 'a', { conversationId: 'cv-1', messageType: 'text', contentText: 'Hi' })).rejects.toBeInstanceOf(SendMessageError);
    expect(captured.message).toBeUndefined();
  });
});
