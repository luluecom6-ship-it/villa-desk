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
  a guest's behalf (both logged). Owner decision 20 Oct 2026: caretakers ALSO approve / reject IDs (owner is often away; verify route is `requireRole('agent')`, uses the service client); only admin/owner read the access log.
  Caretakers must never see deposit amounts. Viewers see no ID files.
- **Logs** never contain ID numbers, file contents or full phone numbers.
- **Time zone** is Asia/Kolkata; no send window (removed 18 Oct 2026); daily limit still applies.
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
- Not built yet: Form C data for occupants (lead only). Form 1 extras (migration 067, needs applying): lead alternate mobile, occupation, emergency contact name + mobile, and each extra guest's mobile, all optional (emergency name and number go together); shown to caretakers+ in the stay drawer via `contacts` in GET /api/stays/[id]. The Forms Pack text itself is not in the repo: anything else on printed Form 1 still needs the owner.
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
- Migration 057 fixes "permission denied for function next_stay_ref" (stays trigger now SECURITY DEFINER); needs applying.
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
  Not on this channel: flows, automations, AI bot, templates. Incoming media is stored (see relay below).
- Immediate sends: a new registration / corrected mobile kicks the scheduler (`kickStayScheduler`), the Stays list kicks it lazily (1/min), and a rejected ID sends `sendIdRejectedMessage` at once (any hour, reason in the guest message only, staff notified if it cannot be sent).
- No automated message waits for the 09:00-20:00 window any more (owner decision 18 Oct 2026; every scheduler send is kind `immediate`; the number's daily limit still applies). Window helpers remain in schedule.ts but are unused.
  The app is for the owner and caretakers; guests only use WhatsApp (sidebar subtitle "Villa operations").
- Guest message escalation (migration 058): `src/lib/stays/escalation/` (plan.ts pure chain: available agents by
  age, then owner, then admins only if no owner; server.ts open/run). Opened from `handleStayInbound` when a
  `conversationId` is passed (Evolution receive + Meta webhook): registered "other" messages, and unregistered
  numbers in villa mode. READY/1/2 still broadcast to staff. `runEscalations` runs inside `runStayScheduler`
  (cron every minute). Reply = a `messages` row with sender_type 'agent' after the chase opened; automatic
  Evolution sends are stored as 'bot'. Per-person `profiles.alert_phone` + `available`, `properties.escalate_after_minutes`
  (Settings -> Your profile card). Rows are resolved, never deleted; no guest text stored.
- Resend (caretaker+): POST /api/stays/[id]/resend `{messageKey}` or `{guestId}` (src/lib/stays/messaging/resend.ts) sends a guest message again, ignoring "still needed" conditions but not the allow-list gate; buttons in the stay drawer (message list, rejected ID). Answers why when it cannot send.
- Form submitted alert: after `submit_stay_form` succeeds the public route (via `after()`) runs `notifyFormSubmitted` (bell for owner/admin/caretakers + WhatsApp to on-duty people with an alert number; stay ref + first name only). The Stays list polls every 30 s while visible.
- ID review history (migration 059): append-only `stay_id_reviews` (approved/rejected, reason, reviewer name), written by the verify route, shown at the bottom of the stay drawer; green tick on approved guests and on the Approved ID badge. UI says "Approve" (API action is still `verify`).
- Guest form shows each adult's ID review (`existing.review` from GET /api/public/stay/[token]): Approved (green, ID fields hidden), Rejected (red, staff's reason, upload again), Waiting. The guest only redoes rejected IDs.
- Agent WhatsApp relay (migration 060, pattern from Jwacrm): `src/lib/stays/relay/` (logic.ts pure: commands, forward text; server.ts: `forwardToResponder`, `onAgentMessage`, `findRelayAgent`). The escalation now copies the guest's message to the responder's own WhatsApp (`profiles.alert_phone`); swipe-reply / `#code` / only-open-chat routes the agent's text to the guest via `sendMessageToConversation` (stored as 'agent'). `conversations.relay_code` is the chat number; `relay_forwards` maps a forwarded copy to its guest. `receiveUpsert` treats team numbers as agents (never guest chats; echoes ignored). Media both ways: `src/lib/evolution/media.ts` stores incoming images/audio/video/files in `chat-media` (webhook base64, else Evolution `getBase64FromMedia`), shown in the inbox and forwarded to the agent as media; an agent's media reply goes to the guest via `sendMessageToConversation`. Note `chat-media` URLs are unguessable but public: IDs must still come through the guest form.
- Relay reliability (19 Oct 2026): numbers not on a stay are forwarded to the agent even with villa mode off; the relay checks the live Evolution state before giving up; failures log `[relay]`/`[escalation]` lines in the Vercel logs.
- When a guest message cannot be copied to a team member's WhatsApp, owners/admins get a bell with the reason (once per 30 min per person; `reportUnreachable` in relay/server.ts). The agent's copy also shows the last 4 messages as context.
- Changing the villa number: log out, scan with the new number. Linking again after a logout lifts the logout pause and restarts the warm-up limits (webhook, status poll and send paths all heal it).
- Team alerts: `notifyStayCreated` (POST /api/stays, everyone but the creator) and `notifyFormSubmitted` (public form submit) → bell + WhatsApp to on-duty people with a number (src/lib/stays/messaging/form-submitted.ts). Numbers are set per person in Settings -> Profile -> Guest messages; owner/admin set everyone's in the same card (GET/POST /api/team/alerts).
- Guest menu (migration 061, `src/lib/stays/menu/logic.ts`, handled in `handleStayInbound`): a registered guest who writes hi/hello/hey/menu/good morning (any case, up to 3 words) gets 1 Update ID / form (link + ID status), 2 WiFi and check-in details (only when IDs are approved), 3 Connect with the caretaker (chased like any guest message; no phone number is shown to guests), 4 Food (see Food ordering), 5 On my way. Answers count for 30 min (`conversations.guest_menu_state/at`); a bare 1-5 with no menu open shows the menu. n8n ping: docs/n8n-stay-ping.json.
- Food ordering (migration 062, `src/lib/stays/food/`, page `/food`, APIs `/api/food/{items,orders,image}`): owner/caretaker keep the menu (name, INR price, on/off, order = the numbers guests see) and one menu picture (`properties.food_menu_image_url`, in `chat-media`). Guest menu option 4 sends the picture (as 'bot' media) + numbered list; the next message is parsed (`1, 3`, `2x2`): numbers make a `food_orders` row (status pending, items/prices snapshot), the caretaker is chased like any guest message (WhatsApp copy says `/ok` or `/no reason`), the guest gets a receipt; approve/decline from the Food page or on WhatsApp by writing *confirm* / *approve* / *decline reason* to the guest (swipe-reply; `/ok` `/no` also work; plain "ok" is deliberately NOT an answer) (`decideOrder`) tells the guest. Words instead of numbers go to the caretaker as a note. Orders are never deleted; dishes are switched off, not deleted. `/food` is in the middleware protected paths. Two pages with a tab switch (`components/food/food-tabs.tsx`): `/food` = orders (waiting, earlier), `/food/menu` = menu settings (picture, dishes, prices).
- Food UPI payment (migration 068, needs applying): `properties.upi_id/upi_payee_name/food_send_upi_qr` set in the Payment card on /food/menu (owner/admin, `/api/food/payment`). Confirming an order (`decideOrder`) then sends the guest a UPI QR for the total (`sendUpiQr`, PNG from the `qrcode` package stored in `chat-media`, message key `food_order_payment`); caretakers mark orders paid by hand (`markOrderPaid`, POST /api/food/orders `{id, paid:true}`, `payment_status`). The app records payment, never moves money; there is no automatic payment check.
- Villa details (Settings -> Profile -> Villa details, owner/admin, GET/POST /api/property): address, map, directions, WiFi + lock text, caretaker phone, times, review link, refund days. The scheduler keeps arrival_info / access_details / arrival_check / checkout_reminder / review_request queued (`property_details_missing`) and bells the owner (once per 12 h) while the needed detail is empty, so a guest never gets a message with a gap. Message wording editor: Settings -> Profile -> Message wording (owner/admin, `/api/stays/templates` GET/PUT/DELETE, `checkTemplateBody` validates variables, live preview with `SAMPLE_VALUES`); overrides live in `stay_message_templates` and are read at send time by the scheduler, resend and access-details reply. Not editable yet: form-received, ID-rejected and guest-menu texts.
- Returning guests: a new registration (or corrected number) that hits `uq_stays_live_phone` first marks that number's stays whose check-out has passed as `checked_out` (`closeFinishedStays` in stays/server.ts), then retries once. A stay still running keeps the number and the 409 stays.
- Past check-out time and not yet marked checked out: the Stays list/drawer badge reads "Check-out due" (amber, `isCheckoutDue`) and there is a "Check-out due" filter chip; nothing is closed automatically (a caretaker marks it, which also moves a Held deposit to Refund due). A WhatsApp type we cannot read (`type: 'unknown'`) from a team member is never relayed to a guest (`agent_unsupported`).
- Mark as checked out: button in the stay drawer (caretaker+, POST /api/stays/[id]/checkout, status only, nothing deleted). The first `form_link` is sent even if check-in has already passed (skipped only after check-out or once the form is submitted).
- Form received receipt: after a form submit (or re-submit) the guest gets "we received your form, pending review" from the villa number (`sendFormReceivedMessage`, messaging/form-received.ts, from the public submit route via `after()`; any hour, no ID details, best effort).
- Rejected ID re-upload (migration 063): a submitted form is read-only after check-in, EXCEPT while any guest's ID is rejected (RPC `submit_stay_form` and `isFormReadOnly(stay, now, hasRejectedId)`), so the link in the "ID rejected" message always works.
- Security deposits (M4, migration 064, needs applying): `deposits` (one per stay, never deleted) + append-only `deposit_audit` (old/new values, who) written by a trigger; `save_deposit()` saves in one transaction. Owner/admin ONLY (RLS `is_account_member(...,'admin')`; API `/api/stays/[id]/deposit` is `requireRole('admin')`); caretakers never see amounts. Rules in `src/lib/stays/deposits/logic.ts` (platform bookings default Not required; held needs amount + date; deduction needs reason and <= amount). Checking a stay out turns Held into Refund due (DB trigger); stays list has an admin-only "Deposit to refund" chip. Drawer card: `components/stays/deposit-card.tsx`. Still to do in M4: audit log for other tables, hardening.
- Drive backup + archive (M4, migration 065, needs applying; docs/villa-drive-backup.md): `stay_documents` gets drive_* + archived_* with a CHECK that refuses `archived_at` unless the Drive copy has the same sha256 and size; append-only `document_archive_log`; `archive_document()`; access log action `drive_open`. Cron-secret routes for n8n under `/api/stays/backup/{pending,confirm,verify-list,verify,export}` (`lib/stays/backup/`; copy verified by size + SHA-256, or Drive md5 against the bytes we hold). Storage meter (`STORAGE_LIMIT_BYTES`, default 1 GB, amber 70%, red 90%, daily bell) in Settings; owner-only `/stays/archive` + `/api/stays/archive` (proposal: verified files of checked-out stays > 90 days, oldest first, down to ~50%; server recomputes on approve). Archived files open from Drive via the same url route (logged). n8n files: docs/n8n-drive-backup.json, docs/n8n-drive-check-export.json.
- Caretaker checklist + damage report (M5, migration 066, needs applying): `checklist_templates` (per villa, owner/admin edit in Settings -> Caretaker checklist), `checklist_runs` (arrival + check-out per stay, template snapshot per run, answers merged per item by RPC `checklist_save_answer`, locked once completed), `checklist_photos` (private `stay-ids` bucket under `account-<id>/checklists/`, 60-second signed URL via POST /api/checklist-photos/[pid]/url), `damage_reports` + append-only `damage_audit` (RPCs `damage_create`, `damage_update`, `damage_apply_to_deposit` which adds the cost to the deposit deduction once). Caretakers run checklists, raise damage and add photos but NEVER see costs (server strips them via `damageForRole`; cost, settle/waive and apply-to-deposit are admin only). Finishing the arrival checklist sets the stay Registered -> Checked in. Check-out vs arrival differences in `diffRuns`. UI: `components/stays/{checklist-runner,stay-checklists}.tsx`, `/stays/damage`. Checklist photos are NOT in the Drive backup/archive or the storage meter yet.
- Next after M3: M4 deposits, audit log, hardening; M5 checklists and damage report.
- Open: house rules are not published yet. The editor on /stays is pre-filled with the 13 rules from
  Form 2 of the Forms Pack (src/lib/stays/default-house-rules.ts); an admin reviews and presses Publish.
  Until then guests see "not open yet".
- Stays UI strings are English in all four catalogues (es/pt/ko not translated yet).

## Register New over WhatsApp (team)
- Owner / admin / caretaker (a relay agent) sends **Register New** to the villa number -> bot replies with a labelled form (`REGISTER_TEMPLATE`). They fill it in and send it back (first line `Register`) -> stay created via `registerFromWhatsApp` (src/lib/stays/register/), confirmation with the Stay Reference; the guest form link goes out via the scheduler. Parsing is forgiving (dates, labels, source words, 10-digit mobile = +91); any problem -> nothing is created and the problems are listed.
- Only plain text that is not a swipe-reply / #code. Deposits are NOT recordable from WhatsApp (owner/admin in the app).
- POST /api/stays now allows `agent` (writes via service client); caretakers do not receive the form link in the response; New registration button shows for anyone who can send messages.
- Old checklist / damage photo cleanup (migration 069, needs applying; owner decision 21 Oct 2026: no Drive backup): owner-only card in Settings -> Storage and backup (`/api/stays/photo-cleanup`, `src/lib/stays/checklist/cleanup.ts`) shows count + size of photos of stays checked out > 90 days ago and deletes the files on confirm (server recomputes the list; photos of damage reports still open / discussed are kept). The `checklist_photos` rows stay (append-only); append-only `checklist_photo_purges` logs who deleted what. Opening a deleted photo returns 410 "deleted". Nothing is deleted automatically.
