// POST /api/evolution/connect  { phone?: string }  (admin+)
// Makes sure this account's Baileys instance exists on the Evolution server,
// points its webhook at us, and returns a QR code. With `phone` (digits, country
// code) it also returns an 8-character pairing code to type on the phone instead.
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { EvolutionError, connect, connectionState, createInstance, fetchInstance, jidDigits, setWebhook } from '@/lib/evolution/client'
import { connFromRow, evolutionServer, evolutionSetupError, loadEvolutionConfig, logEvolutionEvent, webhookUrl } from '@/lib/evolution/server'
import { encrypt } from '@/lib/whatsapp/encryption'

export const maxDuration = 60

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { phone?: string }
    const phone = (body.phone ?? '').replace(/\D/g, '')
    if (body.phone && (phone.length < 8 || phone.length > 15)) {
      return NextResponse.json({ error: 'Enter the phone number with country code, digits only.' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const server = evolutionServer()

    try {
      let row = await loadEvolutionConfig(ctx.accountId, db)
      if (!row) {
        const instance = `villa-${ctx.accountId.replace(/-/g, '').slice(0, 10)}`
        const token = randomBytes(24).toString('hex')
        const adminConn = { baseUrl: server.baseUrl, instance, apiKey: server.globalKey }
        if (!(await fetchInstance(adminConn))) await createInstance(adminConn, token)
        else {
          // Never take over an instance we did not create.
          return NextResponse.json({ error: `An instance named "${instance}" already exists on the Evolution server and is not linked to this app.` }, { status: 409 })
        }
        const { error } = await db.from('evolution_config').insert({
          account_id: ctx.accountId,
          instance_name: instance,
          api_key: encrypt(token),
          webhook_secret: randomBytes(24).toString('hex'),
          created_by: ctx.userId,
        })
        if (error) throw new Error(`config save failed: ${error.code}`)
        row = await loadEvolutionConfig(ctx.accountId, db)
        await logEvolutionEvent(ctx.accountId, 'connect', 'instance_created', db)
      }
      if (!row) throw new Error('config missing')
      const conn = connFromRow(row)

      // The Evolution server may have lost our instance (server rebuilt, instance deleted, number
      // changed on a fresh server). We still hold its token: create it again under the same name.
      const adminConn = { baseUrl: server.baseUrl, instance: conn.instance, apiKey: server.globalKey }
      if (!(await fetchInstance(adminConn).catch(() => 'unknown' as const))) {
        await createInstance(adminConn, conn.apiKey)
        await db.from('evolution_config').update({ state: 'unknown', qr_code: null, pairing_code: null, connected_number: null }).eq('account_id', ctx.accountId)
        row = { ...row, state: 'unknown' }
        await logEvolutionEvent(ctx.accountId, 'connect', 'instance_recreated', db)
      }

      await setWebhook(conn, webhookUrl(request, row.webhook_secret))
      const state = await connectionState(conn)
      let qr: string | null = null
      let pairingCode: string | null = null
      if (state !== 'open') {
        const c = await connect(conn, phone || undefined)
        qr = c.qr
        pairingCode = c.pairingCode
      }
      const info = await fetchInstance(conn).catch(() => null)
      const number = info?.ownerJid && state === 'open' ? jidDigits(info.ownerJid) : null
      await db
        .from('evolution_config')
        .update({
          state,
          qr_code: qr,
          pairing_code: pairingCode,
          qr_updated_at: qr || pairingCode ? new Date().toISOString() : row.qr_updated_at,
          ...(number ? { connected_number: number } : {}),
          ...(info?.profileName && state === 'open' ? { profile_name: info.profileName } : {}),
          updated_at: new Date().toISOString(),
          updated_by: ctx.userId,
        })
        .eq('account_id', ctx.accountId)
      await logEvolutionEvent(ctx.accountId, 'connect', state, db)
      return NextResponse.json({ state, qr, pairingCode })
    } catch (e) {
      const status = e instanceof EvolutionError ? e.status : 0
      await logEvolutionEvent(ctx.accountId, 'connect', status ? `error_${status}` : 'error', db)
      const hint =
        status === 401 ? ' The Evolution key was rejected: check EVOLUTION_API_KEY.' : status === 0 ? ' Check EVOLUTION_BASE_URL is reachable over HTTPS.' : ''
      return NextResponse.json({ error: (e instanceof Error ? e.message : 'Connect failed') + hint }, { status: 502 })
    }
  } catch (err) {
    const setup = evolutionSetupError(err)
    if (setup) return NextResponse.json({ error: setup }, { status: 500 })
    return toErrorResponse(err)
  }
}
