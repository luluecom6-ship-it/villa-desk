/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory stand-in for the Supabase client */
// Test support only: a tiny in-memory stand-in for the Supabase client with
// just the calls the stay messaging code makes.

export type Row = Record<string, any>
const toNum = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).getTime() : (v as number))

class Q {
  private filters: Array<(r: Row) => boolean> = []
  private mode: 'select' | 'update' | 'insert' | 'upsert' = 'select'
  private patch: Row = {}
  private payload: Row[] = []
  private returning = false
  private limitN = Infinity
  private orderCol: string | null = null
  private ignoreDup = false
  constructor(private db: FakeDb, private table: string) {}
  select() { if (this.mode !== 'select') this.returning = true; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  lte(c: string, v: unknown) { this.filters.push((r) => toNum(r[c]) <= toNum(v)); return this }
  gte(c: string, v: unknown) { this.filters.push((r) => toNum(r[c]) >= toNum(v)); return this }
  gt(c: string, v: unknown) { this.filters.push((r) => toNum(r[c]) > toNum(v)); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  order(c: string) { this.orderCol = c; return this }
  limit(n: number) { this.limitN = n; return this }
  update(p: Row) { this.mode = 'update'; this.patch = p; return this }
  insert(rows: Row | Row[]) { this.mode = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
  upsert(rows: Row | Row[], o: { ignoreDuplicates?: boolean }) { this.mode = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.ignoreDup = !!o.ignoreDuplicates; return this }
  single() { return this.run().then((r) => ({ data: r.data?.[0] ?? null, error: r.data?.[0] ? r.error : (r.error ?? { message: 'no rows' }) })) }
  maybeSingle() { return this.run().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })) }
  then(a?: (v: { data: any; error: any }) => unknown, b?: (e: unknown) => unknown) { return this.run().then(a, b) }
  private async run() {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = [])
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const made: Row[] = []
      for (const p of this.payload) {
        if (this.mode === 'upsert' && rows.some((r) => ('message_id' in p ? r.conversation_id === p.conversation_id && r.message_id === p.message_id : r.stay_id === p.stay_id && r.message_key === p.message_key))) continue
        const row = { id: `${this.table}-${++this.db.seq}`, updated_at: new Date(0).toISOString(), attempts: 0, ...(this.table === 'food_orders' ? { status: 'pending', order_no: this.db.seq } : {}), ...(this.table === 'stays' ? { stay_ref: `MS-2026-${String(this.db.seq).padStart(3, '0')}` } : {}), ...p }
        rows.push(row)
        made.push(row)
      }
      return { data: this.returning ? made : null, error: null }
    }
    let m = rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.orderCol) m = [...m].sort((a, b) => toNum(a[this.orderCol!]) - toNum(b[this.orderCol!]))
    m = m.slice(0, this.limitN)
    if (this.mode === 'update') {
      m.forEach((r) => Object.assign(r, this.patch))
      return { data: this.returning ? m : null, error: null }
    }
    return { data: m, error: null }
  }
}
export class FakeDb {
  tables: Record<string, Row[]> = {}
  seq = 0
  from(t: string) { return new Q(this, t) }
}

