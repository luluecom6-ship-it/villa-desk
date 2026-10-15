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
  RLS. Caretaker (agent) must never see ID images or deposit amounts.
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
- Next: M2 public guest form /stay/<token>, ID camera/upload, signed-URL viewing, verify/reject.
- Open: the 13 house rules text (Villa Forms Pack) is not seeded; the guest form needs it.
- Stays UI strings are English in all four catalogues (es/pt/ko not translated yet).
