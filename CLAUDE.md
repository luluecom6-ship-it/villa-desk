@AGENTS.md

# villa-desk (Mahinoor Stays guest desk on WACRM)

This repo is a fresh fork of upstream ArnasDon/wacrm (MIT) that adds a "Stays" module:
guest registration, check-in WhatsApp messaging and deposit tracking for one villa.
The full spec is the Villa Guest Desk PDR (kept in the claude.ai "Villa" project).
Follow it milestone by milestone: M0 setup, M1 stays + dashboard, M2 guest form + ID,
M3 channels + scheduler, M4 deposits + hardening, M5 Phase 2 (checklists, damage).

## Non-negotiable rules (PDR sections 4, 11, 13)

- **Gate:** no automated WhatsApp message leaves unless the number belongs to a stay with
  `automation_ready = true` and not past checkout + 7 days. One function,
  `isAutomationAllowed(accountId, phone)`, answers it. Enforce it inside the single send
  function both channels use, and at the top of the inbound stay handler. A blocked send is
  logged as `blocked_not_registered` and sends nothing. Manual staff messages are not gated.
- **Phones** are stored as digits with country code and matched only on that form.
- **Never delete** stay, guest, acceptance, message or deposit records. No cascade from
  stays to children, no retention timer, no bulk delete. Cancelling is a status.
  The only removable thing is an ID image file, via the Drive-archive flow after a verified
  copy and owner approval (PDR 13.4).
- **ID files:** private `stay-ids` bucket, no storage policy for anon/authenticated, read
  only through the server with a 60-second signed URL, owner/admin only, every open logged.
  Store only the last 4 characters of an ID number, never the full number.
- **Roles:** use the existing `requireRole()` on the server and `is_account_member()` in
  RLS. Owner decision (migration 054): caretakers (agent) MAY view ID images and attach an ID on
  a guest's behalf (both logged); only admin/owner verify or reject IDs and read the access log.
  Caretakers must never see deposit amounts. Viewers see no ID files.
- **Logs** never contain ID numbers, file contents or full phone numbers.
- **Time zone** is Asia/Kolkata; automated sends only 09:00 to 20:00, otherwise wait.
- Migrations are numbered from 047, idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS),
  and every new table has `account_id`, RLS on, and `is_account_member()` policies.
  Run `npm run test:migrations` after changing them.
- Jwacrm (shorts007) is a reference only. Port generic Evolution code; copy no LuLu
  tables, copy or data, and confirm file ownership first.
- This Next.js version has breaking changes: read `node_modules/next/dist/docs/` first.

## Status

- M0: upstream imported, baseline green. Supabase project live, login works on Vercel.
- M1 (done): migrations 047 to 051 applied; Stays dashboard at /stays (list, filters, search,
  New registration, edit, detail drawer, pause automation, add/correct mobile, cancel);
  API /api/stays and /api/stays/[id]; `isAutomationAllowed` in src/lib/stays/automation.ts
  (not yet wired into a send function: that is M3).
- M2 (done, needs migrations 052 and 053 applied): public guest form at /stay/<token> (camera +
  upload, images shrunk in the browser, ID type + last 4, foreign guest fields, house rules
  acceptance with typed signature); API /api/public/stay/[token] (rate limited, token is the only
  credential, neutral 404); transactional RPC `submit_stay_form`; private `stay-ids` uploads with
  magic-byte checks; staff ID review in the stay drawer (signed 60-second link, every open written
  to `document_access_log` first, fail closed; Verify / Reject); house rules editor on /stays
  (append-only versions).
- Migration numbering: shipped files are 047 to 053 in order. 052 = form submit RPC + superseded
  IDs, 053 = document access log. The PDR's later migrations (messages, deposits, audit, ...) take
  the next free numbers (054+), not the PDR's own numbers.
- Limits: Vercel caps a request body at 4.5 MB, so one submit carries at most 4 MB of files and a
  PDF at most 3 MB (PDR said 5 MB). Direct-to-storage upload would lift this. The form rate limit is
  in-memory per server process (weak on serverless).
- Deliberate exceptions: a failed submit removes only its own never-recorded uploads. Saved guests
  and ID files are never removed by the form (replaced IDs are marked superseded).
- Not built yet: Form C data for occupants (lead only). Form 1 extras (alternate mobile, occupation,
  emergency contact, occupant mobiles) are not collected: not in the PDR field list; ask the owner.
- Caretaker ID access (054, needs applying): caretakers view IDs and upload on a guest's behalf
  (`staff_attach_document`, logged as `staff_upload`; the new file resets verification).
- M3 part 1 (done, needs migration 055): scheduler `/api/stays/cron` (setup: docs/villa-scheduler.md),
  `stay_messages` (unique per stay + key, claimed before sending), append-only `stay_message_log`
  (last 4 digits of a phone only), editable `stay_message_templates`, the eleven message keys with the
  PDR 7.1 schedule in IST and the 09:00 to 20:00 window (src/lib/stays/messaging/). The single guest
  send function is `sendStayWhatsApp()`: it re-checks the allow-list at send time and logs
  `blocked_not_registered`. Inbound READY/1/2 + "other" alert in `handleStayInbound()`, hooked into the
  WhatsApp webhook; villa mode (`properties.villa_mode`) keeps flows, automations and the AI bot away
  from unregistered numbers (inbound in the webhook, outbound via `assertVillaSendAllowed`).
  Staff alerts use `notifications` type `stay_alert`. Stay drawer shows each stay's message queue.
- M3 part 2 (done, needs migration 056): **Evolution is the working channel, Meta is parked** (code kept,
  `properties.default_channel` chooses; a guest's own channel `conversations.channel` wins for replies).
  Env vars `EVOLUTION_BASE_URL` + `EVOLUTION_API_KEY`; per-account instance token encrypted in
  `evolution_config` (service role only). `src/lib/evolution/`: client (QR + pairing code), safety (pure:
  warm-up 20/40/70/100 then max, hours in the property time zone, 4-of-5 auto-pause, 401/403 pause),
  safety-server, transport (`evolutionStayTransport`, `sendStaffViaEvolution`), receive (inbound -> inbox +
  `handleStayInbound`), normalize. A transport throws `StayWaitError` to keep a message queued without using
  an attempt. API `/api/evolution/{connect,status,test,logout,pause,settings}` (admin) and
  `/api/evolution/webhook/<secret>`. UI: Settings -> WhatsApp link (mobile-first), banner on /stays.
  `sendMessageToConversation` sends staff inbox messages on Evolution for evolution chats. Logs
  (`evolution_send_log`, `evolution_event_log`) are append-only, last 4 digits only. Docs: docs/villa-evolution.md.
  Not on this channel: flows, automations, AI bot, inbound media storage, templates (plain text only).
- M3 still to do: property settings screen (address, map, access text, templates editor).
- Next after M3: M4 deposits, audit log, hardening; M5 checklists and damage report.
- Open: house rules are not published yet. The editor on /stays is pre-filled with the 13 rules from
  Form 2 of the Forms Pack (src/lib/stays/default-house-rules.ts); an admin reviews and presses Publish.
  Until then guests see "not open yet".
- Stays UI strings are English in all four catalogues (es/pt/ko not translated yet).
