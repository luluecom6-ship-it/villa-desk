# Drive backup and archive (PDR 13.4)

ID photos live in the private `stay-ids` bucket. Supabase's free plan has 1 GB of files, no backups, and pauses a project after a week with no activity. This flow copies every ID file to your Google Drive, watches the storage meter, and (only with the owner's approval) moves old files out of Supabase.

## One-time setup

1. **Apply migration 065** (`supabase/migrations/065_drive_archive.sql`) in the Supabase SQL editor.
2. **Drive folder:** create a folder in the business Google account. Share it with the owner and manager only. Turn **link sharing off**. Use 2-step verification on that account. Copy the folder id (the last part of the folder address).
3. **Vercel env (optional):** `STORAGE_LIMIT_BYTES` if the plan is not the 1 GB free plan (default 1073741824). `AUTOMATION_CRON_SECRET` is the same secret the scheduler ping already uses.
4. **Import two n8n workflows:** `docs/n8n-drive-backup.json` (nightly copy, 02:00) and `docs/n8n-drive-check-export.json` (Sundays 03:00: check Drive files + database export). In each: replace `YOUR-APP.vercel.app`, `PASTE_AUTOMATION_CRON_SECRET`, pick your Google Drive credential, set the folder id, turn **Active**.

## What happens

- **Nightly copy:** the app lists ID files with no verified Drive copy (`GET /api/stays/backup/pending`, 10-minute download links). n8n downloads each, uploads it to Drive, reads the Drive size and md5, and reports to `POST /api/stays/backup/confirm`. The app compares the size and md5 with the bytes it holds. Only a match counts as backed up; a mismatch is logged, the owner is alerted, and the file is copied again next night.
- **Storage meter:** Settings -> Profile -> "Storage and backup" (owner/admin): used vs limit, amber at 70%, red at 90%, how many files have a verified copy. The owner and admins get a bell alert (once a day) at 70% and 90%.
- **Archive proposal (owner only):** `Stays -> /stays/archive` (link in the meter card). At 70% or more it lists the oldest files whose Drive copy is verified, from stays checked out more than 90 days ago, until the projection is about 50%. **Nothing is removed until the owner presses Approve.** The server recomputes the list on approval and archives only files that are on it. The database refuses to archive a file without a matching verified Drive copy.
- **After archiving:** the stay, guests and ID reviews stay in the database. The stay drawer shows "Archived: open front in Drive" (the open is logged in the access log).
- **Weekly check:** n8n looks up every Drive copy. A missing or trashed file alerts the owner; if the file was already archived (Supabase no longer has it) the alert is marked URGENT, restore it from the Drive bin.
- **Weekly database export:** a JSON file (stays, guests, acceptances, deposits, logs, food; no ID images) saved into the same Drive folder.

## Rules that never change

No automatic deletion mode exists. Only the archive flow removes an ID image, only after a verified Drive copy and the owner's approval. Stays, guests, acceptances, messages and deposits are never deleted.
