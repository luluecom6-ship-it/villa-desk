import type { SupabaseClient } from '@supabase/supabase-js'

// Staff alerts go to the team's notification bell (existing notifications
// table, type 'stay_alert'). Alerts never contain ID details or full phone
// numbers: a stay reference, a first name and a short sentence.

export async function notifyStaff(
  db: SupabaseClient,
  accountId: string,
  title: string,
  body: string | null,
  options: { includeCaretakers?: boolean } = {},
): Promise<number> {
  const roles = options.includeCaretakers ? ['owner', 'admin', 'agent'] : ['owner', 'admin']
  const { data: members, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', roles)
  if (error || !members || members.length === 0) return 0

  const rows = members.map((m: { user_id: string }) => ({
    account_id: accountId,
    user_id: m.user_id,
    type: 'stay_alert',
    title: title.slice(0, 200),
    body: body ? body.slice(0, 500) : null,
  }))
  const { error: insertError } = await db.from('notifications').insert(rows)
  if (insertError) {
    console.error('[stay-messages] staff alert failed:', insertError.code)
    return 0
  }
  return rows.length
}
