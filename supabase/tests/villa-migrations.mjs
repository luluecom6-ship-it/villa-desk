// Runs migrations 047-053 against an in-process Postgres (pglite) with small
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
  CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), account_id uuid);
  CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), account_id uuid, user_id uuid,
    type text NOT NULL DEFAULT 'conversation_assigned', title text NOT NULL, body text,
    CONSTRAINT notifications_type_check CHECK (type IN ('conversation_assigned')));
  CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
`);

// Real is_account_member from migration 017 (extract the function body).
const m017 = fs.readFileSync(MIG + '017_account_sharing.sql', 'utf8');
const start = m017.indexOf('CREATE OR REPLACE FUNCTION is_account_member(');
const end = m017.indexOf('GRANT EXECUTE ON FUNCTION is_account_member');
await db.exec(m017.slice(start, end).replace(/ALTER FUNCTION[^;]+;/, ''));

// --- Apply 047-051 twice (idempotency) ------------------------------
const files = fs.readdirSync(MIG).filter(f => /^0(47|48|49|50|51|52|53|54|55|56|57|58|59|60)_/.test(f)).sort();
console.log('migrations:', files.join(', '));
for (const pass_ of [1, 2]) {
  for (const f of files) {
    try { await db.exec(fs.readFileSync(MIG + f, 'utf8')); }
    catch (e) { console.log(`ERROR applying ${f} (run ${pass_}):`, e.message); process.exit(1); }
  }
  ok(`apply 047-053, run ${pass_}`, true);
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
ok('caretaker (agent) can see documents (migration 054)', (await count(agent, 'stay_documents')) > 0);
ok('viewer cannot see documents', (await count(viewer, 'stay_documents')) === 0);
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


// =====================================================================
// M2: public form RPC (052) and ID access log (053)
// =====================================================================
const rpc = async (token, form) =>
  (await db.query(`SELECT public.submit_stay_form($1, $2::jsonb, $3, $4) AS r`, [token, JSON.stringify(form), '203.0.113.7', 'TestAgent/1.0'])).rows[0].r;
const rpcRejects = async (name, token, form, re) => {
  try { await rpc(token, form); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
};
const future = async (acctId, propId, phone, extraCols = '', extraVals = '') =>
  one(`INSERT INTO stays(account_id, property_id, guest_name, guest_phone, checkin_at, checkout_at ${extraCols})
       VALUES ('${acctId}', '${propId}', 'Form Guest', ${phone ? `'${phone}'` : 'NULL'}, now() + interval '2 days', now() + interval '4 days' ${extraVals})
       RETURNING *`);
const sha2 = 'b'.repeat(64);
const doc = (st, key, side, name) => ({ guest_key: key, side, storage_path: `account-${st.account_id}/${st.id}/${name}`, content_type: 'image/jpeg', size_bytes: 1000, sha256: sha2 });
const formFor = (st, rulesId, over = {}) => ({
  lead: { full_name: 'Lead Guest', email: 'lead@example.com', nationality: 'Indian', address: 'Bengaluru', id_type: 'aadhaar', id_last4: '1234', ...(over.lead || {}) },
  arrival: { expected_arrival_time: '15:30', vehicle_number: 'KA01AB1234', special_request: 'Late checkout please', purpose_of_visit: 'leisure', ...(over.arrival || {}) },
  occupants: over.occupants ?? [],
  documents: over.documents ?? [doc(st, 'lead', 'front', 'lead-front.jpg')],
  acceptance: over.acceptance ?? { rules_version_id: rulesId, typed_name: 'Lead Guest' },
});

const sA = await future(acct, prop, '919111111111');
const sB = await future(acct, prop, '919222222222');

await rpcRejects('unknown token => not_found', 'nope-nope-nope', formFor(sA, rv), /stay_form:not_found/);

// Happy path: lead + adult occupant + child, three files.
const r1 = await rpc(sA.form_token, formFor(sA, rv, {
  occupants: [
    { client_key: 'o1', full_name: 'Adult Friend', age: 31, is_adult: true, id_type: 'passport', id_last4: '9876' },
    { client_key: 'o2', full_name: 'Little Child', age: 8, is_adult: false },
  ],
  documents: [
    doc(sA, 'lead', 'front', 'lead-front.jpg'),
    doc(sA, 'lead', 'back', 'lead-back.jpg'),
    doc(sA, 'o1', 'front', 'o1-front.jpg'),
  ],
}));
ok('submit returns ok + reference', r1.ok === true && r1.stay_ref === sA.stay_ref && r1.edited === false, JSON.stringify(r1));
const afterA = await one(`SELECT form_status, form_submitted_at, guest_email, vehicle_number, expected_arrival_time::text AS eta, purpose_of_visit FROM stays WHERE id='${sA.id}'`);
ok('stay marked submitted with arrival details', afterA.form_status === 'submitted' && afterA.form_submitted_at && afterA.guest_email === 'lead@example.com' && afterA.vehicle_number === 'KA01AB1234' && afterA.eta.startsWith('15:30'), JSON.stringify(afterA));
ok('lead + 2 occupants stored', (await one(`SELECT count(*)::int n FROM stay_guests WHERE stay_id='${sA.id}'`)).n === 3);
ok('3 live documents stored', (await one(`SELECT count(*)::int n FROM stay_documents WHERE stay_id='${sA.id}' AND superseded_at IS NULL`)).n === 3);
const acc = await one(`SELECT typed_name, ip_address, user_agent, rules_version_id FROM stay_acceptances WHERE stay_id='${sA.id}'`);
ok('acceptance evidence recorded (name, IP, UA, rules version)', acc.typed_name === 'Lead Guest' && acc.ip_address === '203.0.113.7' && acc.user_agent === 'TestAgent/1.0' && acc.rules_version_id === rv);
ok('stay phone is untouched by the form', (await one(`SELECT guest_phone FROM stays WHERE id='${sA.id}'`)).guest_phone === '919111111111');
ok('lead mobile copied from the stay', (await one(`SELECT mobile FROM stay_guests WHERE stay_id='${sA.id}' AND role='lead'`)).mobile === '919111111111');

// Rollback: an adult without an ID file leaves nothing behind.
await rpcRejects('adult without ID file => id_required', sB.form_token, formFor(sB, rv, {
  occupants: [{ client_key: 'o1', full_name: 'No ID Adult', age: 40, is_adult: true }],
}), /stay_form:id_required/);
ok('failed submit rolled back completely', (await one(`SELECT (SELECT count(*) FROM stay_guests WHERE stay_id='${sB.id}')::int AS g, (SELECT count(*) FROM stay_acceptances WHERE stay_id='${sB.id}')::int AS a, (SELECT form_status FROM stays WHERE id='${sB.id}') AS fs`)).g === 0);
ok('failed submit left no acceptance and form still pending', (await one(`SELECT (SELECT count(*) FROM stay_acceptances WHERE stay_id='${sB.id}')::int AS a, (SELECT form_status FROM stays WHERE id='${sB.id}') AS fs`)).a === 0);

await rpcRejects('file path outside the stay folder rejected', sB.form_token, formFor(sB, rv, {
  documents: [{ ...doc(sB, 'lead', 'front', 'x.jpg'), storage_path: `account-${sB.account_id}/${sA.id}/stolen.jpg` }],
}), /stay_form:bad_path/);
await rpcRejects('document for unknown guest key rejected', sB.form_token, formFor(sB, rv, {
  documents: [doc(sB, 'ghost', 'front', 'x.jpg')],
}), /stay_form:bad_guest/);
await rpcRejects('missing signature rejected', sB.form_token, formFor(sB, rv, { acceptance: { rules_version_id: rv, typed_name: ' ' } }), /stay_form:signature_required/);
await rpcRejects('blank lead name rejected', sB.form_token, formFor(sB, rv, { lead: { full_name: '  ' } }), /stay_form:name_required/);
await rpcRejects('wrong rules version rejected', sB.form_token, formFor(sB, '00000000-0000-4000-8000-000000000000'), /stay_form:rules_changed/);

// Reopen and edit before check-in: supersede, never delete.
const leadId = (await one(`SELECT id FROM stay_guests WHERE stay_id='${sA.id}' AND role='lead'`)).id;
const occId = (await one(`SELECT id FROM stay_guests WHERE stay_id='${sA.id}' AND full_name='Adult Friend'`)).id;
await db.exec(`UPDATE stay_guests SET id_verified_at = now() WHERE id='${leadId}'`);
const before = (await one(`SELECT count(*)::int n FROM stay_documents WHERE stay_id='${sA.id}'`)).n;
const r2 = await rpc(sA.form_token, formFor(sA, rv, {
  lead: { full_name: 'Lead Guest Renamed' },
  occupants: [
    { id: occId, client_key: 'o1', full_name: 'Adult Friend', age: 32, is_adult: true, id_type: 'passport', id_last4: '9876' },
    { client_key: 'o3', full_name: 'New Baby', age: 1, is_adult: false },
  ],
  documents: [doc(sA, 'lead', 'front', 'lead-front-v2.jpg')],
  acceptance: { rules_version_id: '00000000-0000-4000-8000-000000000000', typed_name: 'Someone Else' }, // ignored: already signed
}));
ok('reopened form reports edited', r2.edited === true);
ok('lead renamed in place (same row)', (await one(`SELECT full_name FROM stay_guests WHERE id='${leadId}'`)).full_name === 'Lead Guest Renamed');
ok('existing occupant updated, new one added, none duplicated', (await one(`SELECT count(*)::int n FROM stay_guests WHERE stay_id='${sA.id}'`)).n === 4 && (await one(`SELECT age FROM stay_guests WHERE id='${occId}'`)).age === 32);
ok('old front file superseded, new one live, nothing deleted',
  (await one(`SELECT count(*)::int n FROM stay_documents WHERE stay_id='${sA.id}'`)).n === before + 1 &&
  (await one(`SELECT count(*)::int n FROM stay_documents WHERE guest_id='${leadId}' AND side='front' AND superseded_at IS NOT NULL`)).n === 1 &&
  (await one(`SELECT count(*)::int n FROM stay_documents WHERE guest_id='${leadId}' AND side='front' AND superseded_at IS NULL`)).n === 1);
ok('back file untouched by a front-only re-upload', (await one(`SELECT count(*)::int n FROM stay_documents WHERE guest_id='${leadId}' AND side='back' AND superseded_at IS NULL`)).n === 1);
ok('new upload clears the earlier verification', (await one(`SELECT id_verified_at FROM stay_guests WHERE id='${leadId}'`)).id_verified_at === null);
ok('original signature kept on edit', (await one(`SELECT count(*)::int n, max(typed_name) AS nm FROM stay_acceptances WHERE stay_id='${sA.id}'`)).nm === 'Lead Guest');
await rpcRejects('occupant id from another stay rejected', sA.form_token, formFor(sA, rv, {
  occupants: [{ id: '00000000-0000-4000-8000-000000000001', client_key: 'x', full_name: 'Intruder', age: 5, is_adult: false }],
  documents: [],
}), /stay_form:bad_guest/);

// After check-in an already-submitted form is read-only.
await db.exec(`UPDATE stays SET checkin_at = now() - interval '1 hour' WHERE id='${sA.id}'`);
await rpcRejects('submitted form is read-only after check-in', sA.form_token, formFor(sA, rv, { documents: [] }), /stay_form:closed/);

// ...but a guest who has not submitted yet can still do so until the stay ends.
const sD = await future(acct, prop, '919333333333');
await db.exec(`UPDATE stays SET checkin_at = now() - interval '2 hours' WHERE id='${sD.id}'`);
const rD = await rpc(sD.form_token, formFor(sD, rv));
ok('first submission allowed after check-in time, before checkout', rD.ok === true);

// Cancelled and finished stays look like unknown links.
const sE = await future(acct, prop, '919444444444');
await db.exec(`UPDATE stays SET status='cancelled' WHERE id='${sE.id}'`);
await rpcRejects('cancelled stay => not_found', sE.form_token, formFor(sE, rv), /stay_form:not_found/);
const sF = await future(acct, prop, '919555555555');
await db.exec(`UPDATE stays SET checkin_at = now() - interval '3 days', checkout_at = now() - interval '1 day' WHERE id='${sF.id}'`);
await rpcRejects('finished stay => not_found', sF.form_token, formFor(sF, rv), /stay_form:not_found/);

// Rules: none published => no_rules; a newer version invalidates a stale form.
const prop2 = (await one(`INSERT INTO properties(account_id, name) VALUES ('${acct2}', 'V2b') RETURNING id`)).id;
const sG = await future(acct2, prop2, '919666666666');
await rpcRejects('no published rules => no_rules', sG.form_token, formFor(sG, rv), /stay_form:no_rules/);
const rv2a = (await one(`INSERT INTO house_rules_versions(account_id, version, body) VALUES ('${acct2}', 1, 'v1') RETURNING id`)).id;
await db.exec(`INSERT INTO house_rules_versions(account_id, version, body) VALUES ('${acct2}', 2, 'v2')`);
await rpcRejects('stale rules version => rules_changed', sG.form_token, formFor(sG, rv2a), /stay_form:rules_changed/);

// The RPC is service-role only.
let rpcBlocked = false;
try { await as(admin, `SELECT public.submit_stay_form('x', '{}'::jsonb, '', '')`); } catch { rpcBlocked = true; }
ok('signed-in users cannot call submit_stay_form directly', rpcBlocked);

// Access log: append-only, admin-readable, no client writes.
const docId = (await one(`SELECT id FROM stay_documents WHERE stay_id='${sA.id}' AND superseded_at IS NULL LIMIT 1`)).id;
await db.exec(`INSERT INTO document_access_log(account_id, stay_id, document_id, opened_by, opened_role) VALUES ('${acct}','${sA.id}','${docId}','${admin}','admin')`);
await rejects('access log rows cannot be edited', `UPDATE document_access_log SET opened_role = 'owner'`, /immutable/);
await rejects('access log rows cannot be deleted', `DELETE FROM document_access_log`, /cannot be deleted/);
ok('admin can read the access log', (await count(admin, 'document_access_log')) === 1);
ok('caretaker cannot read the access log', (await count(agent, 'document_access_log')) === 0);
let logWriteBlocked = false;
try { await as(admin, `INSERT INTO document_access_log(account_id, stay_id, document_id) VALUES ('${acct}','${sA.id}','${docId}')`); } catch { logWriteBlocked = true; }
ok('signed-in users cannot write the access log', logWriteBlocked);
await rejects('a document with log entries cannot be deleted', `DELETE FROM stay_documents WHERE id='${docId}'`, /foreign key|violates/i);


// ---- Migration 054: caretaker ID access + staff upload --------------------
const gA = (await one(`SELECT id FROM stay_guests WHERE stay_id='${sA.id}' AND role='lead'`)).id;
const sha54 = 'b'.repeat(64);
const attach = (path, side = 'front', stay = sA.id, guest = gA, acc = acct) =>
  one(`SELECT public.staff_attach_document('${acc}','${stay}','${guest}','${side}','${path}','image/jpeg',1234,'${sha54}','${agent}','agent') AS id`);
await db.exec(`UPDATE stay_guests SET id_verified_at = now() WHERE id='${gA}'`);
const oldDoc = (await one(`SELECT id FROM stay_documents WHERE guest_id='${gA}' AND side='front' AND superseded_at IS NULL`)).id;
const newDoc = (await attach(`account-${acct}/${sA.id}/staff1.jpg`)).id;
ok('staff upload supersedes the old live file, never deletes it',
  (await one(`SELECT superseded_at IS NOT NULL AS s FROM stay_documents WHERE id='${oldDoc}'`)).s === true &&
  (await one(`SELECT count(*)::int n FROM stay_documents WHERE guest_id='${gA}' AND side='front' AND superseded_at IS NULL`)).n === 1);
ok('staff upload records who uploaded it', (await one(`SELECT uploaded_by FROM stay_documents WHERE id='${newDoc}'`)).uploaded_by === agent);
ok('staff upload sends the guest back to review', (await one(`SELECT id_verified_at FROM stay_guests WHERE id='${gA}'`)).id_verified_at === null);
ok('staff upload is written to the access log',
  (await one(`SELECT count(*)::int n FROM document_access_log WHERE document_id='${newDoc}' AND action='staff_upload' AND opened_role='agent'`)).n === 1);
await attach(`account-${acct}/${sA.id}/staff2.jpg`, 'back');
ok('staff can add a back side', (await one(`SELECT count(*)::int n FROM stay_documents WHERE guest_id='${gA}' AND side='back' AND superseded_at IS NULL`)).n === 1);
await rejects('staff upload: path outside the stay folder', `SELECT public.staff_attach_document('${acct}','${sA.id}','${gA}','front','account-x/other/a.jpg','image/jpeg',1,'${sha54}','${agent}','agent')`, /stay_doc:bad_path/);
await rejects('staff upload: wrong account', `SELECT public.staff_attach_document('${acct2}','${sA.id}','${gA}','front','account-${acct2}/${sA.id}/a.jpg','image/jpeg',1,'${sha54}','${agent}','agent')`, /stay_doc:not_found/);
await rejects('staff upload: guest from another stay', `SELECT public.staff_attach_document('${acct}','${sB.id}','${gA}','front','account-${acct}/${sB.id}/a.jpg','image/jpeg',1,'${sha54}','${agent}','agent')`, /stay_doc:bad_guest/);
await rejects('staff upload: bad side', `SELECT public.staff_attach_document('${acct}','${sA.id}','${gA}','top','account-${acct}/${sA.id}/a.jpg','image/jpeg',1,'${sha54}','${agent}','agent')`, /stay_doc:bad_side/);
let attachBlocked = false;
try { await as(agent, `SELECT public.staff_attach_document('${acct}','${sA.id}','${gA}','front','account-${acct}/${sA.id}/z.jpg','image/jpeg',1,'${sha54}','${agent}','agent')`); } catch { attachBlocked = true; }
ok('signed-in users cannot call staff_attach_document directly', attachBlocked);
ok('caretaker still cannot read the access log', (await count(agent, 'document_access_log')) === 0);


// ---- Migration 055: stay messages ------------------------------------------
const sM = await future(acct, prop, '919777777777');
const addMsg = (key, status = 'queued') =>
  db.exec(`INSERT INTO stay_messages(account_id, stay_id, message_key, due_at, status) VALUES ('${acct}','${sM.id}','${key}', now(), '${status}')`);
await addMsg('form_link');
await rejects('one row per stay and message key (no double send)', `INSERT INTO stay_messages(account_id, stay_id, message_key, due_at) VALUES ('${acct}','${sM.id}','form_link', now())`, /duplicate key|unique/i);
await rejects('unknown message key refused', `INSERT INTO stay_messages(account_id, stay_id, message_key, due_at) VALUES ('${acct}','${sM.id}','spam', now())`, /check/i);
await rejects('stay_message must belong to the same account', `INSERT INTO stay_messages(account_id, stay_id, message_key, due_at) VALUES ('${acct2}','${sM.id}','arrival_info', now())`, /./);
await addMsg('arrival_info'); await addMsg('review_request', 'sent');
await db.exec(`UPDATE stays SET status = 'cancelled' WHERE id='${sM.id}'`);
ok('cancelling a stay cancels queued messages', (await one(`SELECT count(*)::int n FROM stay_messages WHERE stay_id='${sM.id}' AND status='cancelled'`)).n === 2);
ok('cancelling keeps sent history', (await one(`SELECT status FROM stay_messages WHERE stay_id='${sM.id}' AND message_key='review_request'`)).status === 'sent');
ok('cancelled messages are never deleted', (await one(`SELECT count(*)::int n FROM stay_messages WHERE stay_id='${sM.id}'`)).n === 3);
await db.exec(`INSERT INTO stay_message_log(account_id, stay_id, message_key, outcome, reason, phone_tail) VALUES ('${acct}','${sM.id}','form_link','blocked_not_registered','not_on_allow_list','7777')`);
await rejects('message log refuses a full phone number', `INSERT INTO stay_message_log(account_id, outcome, phone_tail) VALUES ('${acct}','sent','919777777777')`, /check/i);
await rejects('message log rows cannot be edited', `UPDATE stay_message_log SET outcome='sent'`, /immutable/);
await rejects('message log rows cannot be deleted', `DELETE FROM stay_message_log`, /cannot be deleted/);
ok('admin reads the message log', (await count(admin, 'stay_message_log')) === 1);
ok('caretaker cannot read the message log', (await count(agent, 'stay_message_log')) === 0);
ok('caretaker can read stay messages', (await count(agent, 'stay_messages')) === 3);
ok('viewer cannot read stay messages', (await count(viewer, 'stay_messages')) === 0);
let msgWriteBlocked = false;
try { await as(admin, `INSERT INTO stay_messages(account_id, stay_id, message_key, due_at) VALUES ('${acct}','${sM.id}','owner_alert', now())`); } catch { msgWriteBlocked = true; }
ok('signed-in users cannot write stay_messages', msgWriteBlocked);
await as(admin, `INSERT INTO stay_message_templates(account_id, message_key, body) VALUES ('${acct}','form_link','Hi {guest_first_name}')`);
ok('admin can save a template', (await count(admin, 'stay_message_templates')) === 1);
let tplBlocked = false;
try { await as(agent, `INSERT INTO stay_message_templates(account_id, message_key, body) VALUES ('${acct}','arrival_info','x')`); } catch { tplBlocked = true; }
ok('caretaker cannot edit templates', tplBlocked);
await db.exec(`INSERT INTO notifications(account_id, user_id, type, title) VALUES ('${acct}','${owner}','stay_alert','x')`);
ok('notifications accept the stay_alert type', true);
await db.exec(`INSERT INTO conversations(account_id) VALUES ('${acct}')`);
await db.exec(`UPDATE conversations SET channel='meta'`);
await rejects('conversation channel is meta, evolution or empty', `UPDATE conversations SET channel='sms'`, /check/i);

// ---- Migration 056: Evolution channel ----------------------------------------
await db.exec(`INSERT INTO evolution_config(account_id, instance_name, api_key, webhook_secret) VALUES ('${acct}','villa','enc','${'a'.repeat(48)}')`);
const evo = await one(`SELECT max_daily, window_start_hour, window_end_hour, auto_pause, state FROM evolution_config`);
ok('evolution defaults: 100/day, 09:00 to 20:00, auto-pause on', evo.max_daily === 100 && evo.window_start_hour === 9 && evo.window_end_hour === 20 && evo.auto_pause === true && evo.state === 'unknown');
await rejects('evolution window must start before it ends', `UPDATE evolution_config SET window_start_hour=20, window_end_hour=9`, /check/i);
await rejects('evolution state is a known value', `UPDATE evolution_config SET state='banana'`, /check/i);
await db.exec(`INSERT INTO evolution_send_log(account_id, ok, kind, phone_tail) VALUES ('${acct}', true, 'scheduled', '7777')`);
await rejects('send log refuses a full phone number', `INSERT INTO evolution_send_log(account_id, ok, phone_tail) VALUES ('${acct}', true, '919777777777')`, /check/i);
await rejects('send log rows cannot be edited', `UPDATE evolution_send_log SET ok=false`, /immutable/);
await rejects('send log rows cannot be deleted', `DELETE FROM evolution_send_log`, /cannot be deleted/);
await db.exec(`INSERT INTO evolution_event_log(account_id, event, outcome) VALUES ('${acct}','connection.update','open')`);
await rejects('event log rows cannot be deleted', `DELETE FROM evolution_event_log`, /cannot be deleted/);
await rejects('event log rows cannot be edited', `UPDATE evolution_event_log SET outcome='x'`, /immutable/);

// ---- Migration 057: a signed-in admin can create a stay -----------------------
let adminCreated = true;
try {
  await as(admin, `INSERT INTO stays(account_id, property_id, guest_name, guest_phone, checkin_at, checkout_at) VALUES ('${acct}', (SELECT id FROM properties WHERE account_id='${acct}' LIMIT 1), 'RLS Guest', '919800000001', now() + interval '2 days', now() + interval '4 days')`);
} catch (e) { adminCreated = false; console.log(e.message); }
ok('a signed-in admin can create a stay (stay_ref assigned by the trigger)', adminCreated);
let directCall = false;
try { await as(admin, `SELECT public.next_stay_ref('${acct}', 2026)`); directCall = true; } catch { directCall = false; }
ok('signed-in users still cannot call next_stay_ref directly', !directCall);

// ---- Migration 058: guest message escalation ----------------------------------
await rejects('alert phone must be digits with country code', `UPDATE profiles SET alert_phone='+91 98'`, /check/i);
ok('profiles are available by default', (await one(`SELECT count(*)::int n FROM profiles WHERE available IS NOT TRUE`)).n === 0);
await rejects('escalation wait is 1 to 240 minutes', `UPDATE properties SET escalate_after_minutes=0`, /check/i);
const convE = (await one(`INSERT INTO conversations(account_id) VALUES ('${acct}') RETURNING id`)).id;
await db.exec(`INSERT INTO conversation_escalations(account_id, conversation_id, due_at) VALUES ('${acct}','${convE}', now() + interval '10 minutes')`);
await rejects('only one open escalation per conversation', `INSERT INTO conversation_escalations(account_id, conversation_id, due_at) VALUES ('${acct}','${convE}', now())`, /unique|duplicate/i);
await rejects('a resolved row needs a resolved time', `UPDATE conversation_escalations SET status='resolved'`, /check/i);
await db.exec(`UPDATE conversation_escalations SET status='resolved', resolved_at=now(), resolved_reason='replied'`);
await db.exec(`INSERT INTO conversation_escalations(account_id, conversation_id, due_at) VALUES ('${acct}','${convE}', now())`);
ok('a new chase can open after the old one is resolved', true);
await rejects('escalations are never deleted', `DELETE FROM conversation_escalations`, /cannot be deleted/);
ok('caretaker can read escalations', (await count(agent, 'conversation_escalations')) === 2);
ok('viewer cannot read escalations', (await count(viewer, 'conversation_escalations')) === 0);

// ---- Migration 059: ID review history -----------------------------------------
const stayR = (await one(`SELECT id FROM stays WHERE account_id='${acct}' LIMIT 1`)).id;
const guestR = (await one(`INSERT INTO stay_guests(account_id, stay_id, role, full_name, is_adult) VALUES ('${acct}','${stayR}','lead','Review Guest', true) RETURNING id`)).id;
await db.exec(`INSERT INTO stay_id_reviews(account_id, stay_id, guest_id, action, reason, reviewer_name) VALUES ('${acct}','${stayR}','${guestR}','rejected','Photo is blurry','Owner')`);
await db.exec(`INSERT INTO stay_id_reviews(account_id, stay_id, guest_id, action) VALUES ('${acct}','${stayR}','${guestR}','approved')`);
await rejects('a rejection must carry a reason', `INSERT INTO stay_id_reviews(account_id, stay_id, guest_id, action) VALUES ('${acct}','${stayR}','${guestR}','rejected')`, /check/i);
await rejects('an approval carries no reason', `INSERT INTO stay_id_reviews(account_id, stay_id, guest_id, action, reason) VALUES ('${acct}','${stayR}','${guestR}','approved','x')`, /check/i);
await rejects('review history is never edited', `UPDATE stay_id_reviews SET reason='changed'`, /immutable/);
await rejects('review history is never deleted', `DELETE FROM stay_id_reviews`, /cannot be deleted/);
ok('caretaker can read the review history', (await count(agent, 'stay_id_reviews')) === 2);
ok('viewer cannot read the review history', (await count(viewer, 'stay_id_reviews')) === 0);

// ---- Migration 060: agent WhatsApp relay ------------------------------------------
const convA = (await one(`INSERT INTO conversations(account_id) VALUES ('${acct}') RETURNING id, relay_code`));
const convB = (await one(`INSERT INTO conversations(account_id) VALUES ('${acct}') RETURNING id, relay_code`));
ok('every conversation gets its own short code', convA.relay_code != null && convB.relay_code != null && convA.relay_code !== convB.relay_code);
await rejects('a short code is unique', `UPDATE conversations SET relay_code=${convA.relay_code} WHERE id='${convB.id}'`, /unique|duplicate/i);
await db.exec(`INSERT INTO relay_forwards(account_id, conversation_id, user_id, forward_message_id, source_message_id) VALUES ('${acct}','${convA.id}','${acct}','FWD1','SRC1')`);
await rejects('a guest message is forwarded to the same agent once', `INSERT INTO relay_forwards(account_id, conversation_id, user_id, source_message_id) VALUES ('${acct}','${convA.id}','${acct}','SRC1')`, /unique|duplicate/i);
await rejects('forward records are never edited', `UPDATE relay_forwards SET forward_message_id='x'`, /immutable/);
await rejects('forward records are never deleted', `DELETE FROM relay_forwards`, /cannot be deleted/);
ok('caretaker can read forwards', (await count(agent, 'relay_forwards')) === 1);
ok('viewer cannot read forwards', (await count(viewer, 'relay_forwards')) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
