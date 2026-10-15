// Runs migrations 047-051 against an in-process Postgres (pglite) with small
// stubs for Supabase auth/storage, then checks the PDR rules (stay refs,
// automation_ready, immutability, RLS roles). No network or database needed.
//   npm run test:migrations
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import fs from 'node:fs';

const MIG = new URL('../migrations/', import.meta.url).pathname;
const db = new PGlite({ extensions: { uuid_ossp } });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};
const rejects = async (name, sql, re) => {
  try { await db.exec(sql); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re ? re.test(e.message) : true, e.message); }
};

// --- Supabase stubs -------------------------------------------------
await db.exec(`CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;`);
await db.exec(`CREATE ROLE postgres SUPERUSER`).catch(() => {});
await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT uuid_generate_v4());
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint);
  CREATE TYPE account_role_enum AS ENUM ('owner','admin','agent','viewer');
  CREATE TABLE accounts (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text NOT NULL,
    owner_user_id uuid NOT NULL REFERENCES auth.users(id));
  CREATE TABLE profiles (user_id uuid PRIMARY KEY REFERENCES auth.users(id),
    account_id uuid REFERENCES accounts(id), account_role account_role_enum);
  CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), account_id uuid, phone text);
  CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
`);

// Real is_account_member from migration 017 (extract the function body).
const m017 = fs.readFileSync(MIG + '017_account_sharing.sql', 'utf8');
const start = m017.indexOf('CREATE OR REPLACE FUNCTION is_account_member(');
const end = m017.indexOf('GRANT EXECUTE ON FUNCTION is_account_member');
await db.exec(m017.slice(start, end).replace(/ALTER FUNCTION[^;]+;/, ''));

// --- Apply 047-051 twice (idempotency) ------------------------------
const files = fs.readdirSync(MIG).filter(f => /^0(47|48|49|50|51)_/.test(f)).sort();
console.log('migrations:', files.join(', '));
for (const pass_ of [1, 2]) {
  for (const f of files) {
    try { await db.exec(fs.readFileSync(MIG + f, 'utf8')); }
    catch (e) { console.log(`ERROR applying ${f} (run ${pass_}):`, e.message); process.exit(1); }
  }
  ok(`apply 047-051, run ${pass_}`, true);
}

// --- Fixtures -------------------------------------------------------
const one = async (sql) => (await db.query(sql)).rows[0];
const owner = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const acct = (await one(`INSERT INTO accounts(name, owner_user_id) VALUES ('Mahinoor', '${owner}') RETURNING id`)).id;
const acct2 = (await one(`INSERT INTO accounts(name, owner_user_id) VALUES ('Other', '${owner}') RETURNING id`)).id;
const prop = (await one(`INSERT INTO properties(account_id, name) VALUES ('${acct}', 'Villa') RETURNING id`)).id;

const mk = (phone, extra = '') =>
  `INSERT INTO stays(account_id, property_id, guest_name, guest_phone, checkin_at, checkout_at ${extra ? ',' + extra.cols : ''})
   VALUES ('${acct}', '${prop}', 'Guest', ${phone === null ? 'NULL' : `'${phone}'`}, '2026-11-01 14:00+05:30', '2026-11-03 11:00+05:30' ${extra ? ',' + extra.vals : ''})
   RETURNING *`;

// 14.1 test 1: no mobile -> has ref, draft, automation_ready false
const s1 = await one(mk(null));
const yr = new Date().getFullYear();
ok('draft stay gets MS-YYYY-NNN ref', /^MS-\d{4}-001$/.test(s1.stay_ref), s1.stay_ref);
ok('no mobile => status draft', s1.status === 'draft');
ok('no mobile => automation_ready = false', s1.automation_ready === false);
ok('form token is 14 chars', s1.form_token.length === 14, s1.form_token);

// test 2: add mobile -> registered + automation_ready true
await db.exec(`UPDATE stays SET guest_phone = '+91 98765-43210' WHERE id = '${s1.id}'`);
const s1b = await one(`SELECT * FROM stays WHERE id='${s1.id}'`);
ok('phone normalised to digits', s1b.guest_phone === '919876543210', s1b.guest_phone);
ok('adding mobile => registered', s1b.status === 'registered', s1b.status);
ok('adding mobile => automation_ready = true', s1b.automation_ready === true);

// pause switches automation off without cancelling
await db.exec(`UPDATE stays SET automation_paused = true WHERE id='${s1.id}'`);
ok('paused => automation_ready false', (await one(`SELECT automation_ready FROM stays WHERE id='${s1.id}'`)).automation_ready === false);
await db.exec(`UPDATE stays SET automation_paused = false WHERE id='${s1.id}'`);

// removing the mobile stops automation immediately
await db.exec(`UPDATE stays SET guest_phone = NULL WHERE id='${s1.id}'`);
const s1c = await one(`SELECT * FROM stays WHERE id='${s1.id}'`);
ok('removing mobile => draft + automation off', s1c.status === 'draft' && s1c.automation_ready === false);
await db.exec(`UPDATE stays SET guest_phone = '919876543210' WHERE id='${s1.id}'`);

// cancelled / sample never ready
await db.exec(`UPDATE stays SET status = 'cancelled' WHERE id='${s1.id}'`);
ok('cancelled never ready', (await one(`SELECT automation_ready FROM stays WHERE id='${s1.id}'`)).automation_ready === false);
await db.exec(`UPDATE stays SET status = 'registered' WHERE id='${s1.id}'`);

// sequence + per-account independence
const s2 = await one(mk('919000000002'));
ok('second stay gets 002', s2.stay_ref.endsWith('-002'), s2.stay_ref);
const other = await one(`INSERT INTO properties(account_id, name) VALUES ('${acct2}', 'V2') RETURNING id`);
const so = await one(`INSERT INTO stays(account_id, property_id, guest_name, checkin_at, checkout_at)
  VALUES ('${acct2}', '${other.id}', 'X', '2026-11-01', '2026-11-02') RETURNING stay_ref`);
ok('other account sequence starts at 001', so.stay_ref.endsWith('-001'), so.stay_ref);

// stay_ref immutable
await rejects('stay_ref cannot be changed', `UPDATE stays SET stay_ref = 'MS-2026-999' WHERE id='${s1.id}'`, /immutable/);

// one live stay per number
await rejects('two live stays on one number rejected', mk('919876543210'), /uq_stays_live_phone|duplicate/);

// bad inputs
await rejects('checkout before checkin rejected',
  `INSERT INTO stays(account_id, property_id, guest_name, checkin_at, checkout_at) VALUES ('${acct}','${prop}','x','2026-11-05','2026-11-04')`, /check/i);
await rejects('absurd phone rejected', mk('12'), /phone|check/i);

// external ref trimmed, 100-char cap, duplicates allowed
const s3 = await one(mk(null, { cols: 'external_booking_ref, source', vals: `'  HMABCD1234  ', 'airbnb'` }));
ok('external ref trimmed', s3.external_booking_ref === 'HMABCD1234', s3.external_booking_ref);
const s4 = await one(mk(null, { cols: 'external_booking_ref, source', vals: `'HMABCD1234', 'airbnb'` }));
ok('same external ref twice is allowed', !!s4.id);
await rejects('external ref > 100 chars rejected',
  mk(null, { cols: 'external_booking_ref', vals: `'${'x'.repeat(101)}'` }), /check/i);

// concurrency-ish: 30 sequential inserts give 30 distinct refs
const refs = new Set();
for (let i = 0; i < 30; i++) refs.add((await one(mk(null))).stay_ref);
ok('30 stays => 30 distinct references', refs.size === 30);

// guests / documents / acceptances
const g = (await one(`INSERT INTO stay_guests(account_id, stay_id, role, full_name, id_type, id_last4)
  VALUES ('${acct}', '${s1.id}', 'lead', 'Lead Guest', 'aadhaar', '1234') RETURNING id`)).id;
await rejects('only one lead per stay',
  `INSERT INTO stay_guests(account_id, stay_id, role, full_name) VALUES ('${acct}','${s1.id}','lead','Second')`, /uq_stay_guests_one_lead|duplicate/);
await rejects('full ID number cannot be stored in id_last4',
  `INSERT INTO stay_guests(account_id, stay_id, role, full_name, id_last4) VALUES ('${acct}','${s1.id}','occupant','Y','123456789012')`, /check/i);
await rejects('child row must match stay account',
  `INSERT INTO stay_guests(account_id, stay_id, role, full_name) VALUES ('${acct2}','${s1.id}','occupant','Z')`, /does not match/);
await rejects('verified and rejected are exclusive',
  `UPDATE stay_guests SET id_verified_at = now(), id_rejected_at = now() WHERE id='${g}'`, /check/i);

const sha = 'a'.repeat(64);
await db.exec(`INSERT INTO stay_documents(account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256)
  VALUES ('${acct}','${s1.id}','${g}','front','account-x/s/front.jpg','image/jpeg',1000,'${sha}')`);
await rejects('no 3rd file side / duplicate side per guest',
  `INSERT INTO stay_documents(account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256)
   VALUES ('${acct}','${s1.id}','${g}','front','account-x/s/front2.jpg','image/jpeg',1000,'${sha}')`, /uq_stay_documents_guest_side|duplicate/);
await rejects('files over 8 MB rejected',
  `INSERT INTO stay_documents(account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256)
   VALUES ('${acct}','${s1.id}','${g}','back','p','image/jpeg',9000000,'${sha}')`, /check/i);
await rejects('executables rejected by content_type check',
  `INSERT INTO stay_documents(account_id, stay_id, guest_id, side, storage_path, content_type, size_bytes, sha256)
   VALUES ('${acct}','${s1.id}','${g}','back','p2','application/x-msdownload',10,'${sha}')`, /check/i);
const bucket = await one(`SELECT public FROM storage.buckets WHERE id='stay-ids'`);
ok('stay-ids bucket exists and is private', bucket && bucket.public === false);

const rv = (await one(`INSERT INTO house_rules_versions(account_id, version, body) VALUES ('${acct}', 1, 'rules v1') RETURNING id`)).id;
await db.exec(`INSERT INTO stay_acceptances(account_id, stay_id, rules_version_id, typed_name, ip_address, user_agent)
  VALUES ('${acct}','${s1.id}','${rv}','Lead Guest','1.2.3.4','UA')`);
await rejects('one acceptance per stay',
  `INSERT INTO stay_acceptances(account_id, stay_id, rules_version_id, typed_name) VALUES ('${acct}','${s1.id}','${rv}','Again')`, /uq_stay_acceptances_stay|duplicate/);
await rejects('acceptance cannot be edited', `UPDATE stay_acceptances SET typed_name = 'Changed'`, /immutable/);
await rejects('published rules cannot be edited', `UPDATE house_rules_versions SET body = 'changed'`, /immutable/);

// 14.1 test 9: deleting a stay with documents is rejected by the database
await rejects('deleting a stay with documents is rejected', `DELETE FROM stays WHERE id='${s1.id}'`, /foreign key|violates/i);

// --- RLS: roles ------------------------------------------------------
await db.exec(`GRANT USAGE ON SCHEMA public, auth TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA auth TO authenticated;
  GRANT EXECUTE ON FUNCTION is_account_member(uuid, account_role_enum) TO authenticated;`);
const mkUser = async (role) => {
  const u = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
  await db.exec(`INSERT INTO profiles(user_id, account_id, account_role) VALUES ('${u}','${acct}','${role}')`);
  return u;
};
const admin = await mkUser('admin'), agent = await mkUser('agent'), viewer = await mkUser('viewer');
const as = async (uid, sql) => {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false);`);
  try { return await db.query(sql); } finally { await db.exec('RESET ROLE'); }
};
const count = async (uid, t) => Number((await as(uid, `SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);

ok('admin sees documents', (await count(admin, 'stay_documents')) === 1);
ok('caretaker (agent) cannot see documents', (await count(agent, 'stay_documents')) === 0);
ok('viewer cannot see documents', (await count(viewer, 'stay_documents')) === 0);
ok('caretaker sees stays', (await count(agent, 'stays')) > 0);
ok('viewer sees stays', (await count(viewer, 'stays')) > 0);
let blocked = false;
try { await as(agent, `UPDATE stays SET notes='x'`); const r = await as(agent, `SELECT count(*)::int n FROM stays WHERE notes='x'`); blocked = r.rows[0].n === 0; } catch { blocked = true; }
ok('caretaker cannot edit stays', blocked);
let delBlocked = false;
try { const r = await as(admin, `DELETE FROM stays RETURNING id`); delBlocked = r.rows.length === 0; } catch { delBlocked = true; }
ok('admin cannot delete stays via API (no policy)', delBlocked);
let nextRefBlocked = false;
try { await as(admin, `SELECT next_stay_ref('${acct}', 2026)`); } catch { nextRefBlocked = true; }
ok('authenticated cannot call next_stay_ref directly', nextRefBlocked);
const other_acct_user = await (async () => { const u = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id; await db.exec(`INSERT INTO profiles(user_id, account_id, account_role) VALUES ('${u}','${acct2}','owner')`); return u; })();
ok('other account cannot see these stays', (await as(other_acct_user, `SELECT count(*)::int n FROM stays WHERE account_id='${acct}'`)).rows[0].n === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
