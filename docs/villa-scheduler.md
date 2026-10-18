# Villa stay messages: scheduler setup

The scheduler sends the stay WhatsApp messages (form link, reminders, arrival info,
access details, check-out reminder, review request) and raises the two staff alerts.
It runs when `/api/stays/cron` is called. Call it **every 15 minutes**.

```
GET https://<your-app>/api/stays/cron
x-cron-secret: <value of AUTOMATION_CRON_SECRET>
```

`AUTOMATION_CRON_SECRET` is the same secret the existing `/api/automations/cron` uses.
Set it in the host's environment variables (Vercel: Project, Settings, Environment Variables).

Any scheduler that can send a GET with a header works:

- cron-job.org (free): new cron job, URL above, schedule "every 15 minutes", add the header.
- Vercel Cron (Pro plan only for 15-minute schedules).
- A host/Docker cron: `*/15 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://<app>/api/stays/cron`

The response is a small summary, e.g. `{"ok":true,"queued":11,"sent":1,"waiting":0,...}`.
Calling it twice in a row is safe: each message is sent once.

## What it does

- Guest messages go out only between 09:00 and 20:00 IST; anything due outside waits until 09:00.
- Before every send it re-checks that the number belongs to a registered, active stay.
  Otherwise nothing is sent and the row is logged as `blocked_not_registered`.
- A failed send retries 15 minutes later, up to 3 times, then the team gets a notification.
- Staff alerts (IDs to verify, form incomplete on arrival day) appear in the notification bell.

## Before it can send

1. Apply migration `055_stay_messages.sql`.
2. Fill in the property details used by the messages (address, map link, directions,
   access instructions, caretaker phone, review link). They are stored on the `properties` row;
   a settings screen for them is not built yet, so edit the row in Supabase for now.
3. Meta WhatsApp: a business-started message outside the 24-hour window needs an approved
   template. Save the approved template name per message in `stay_message_templates.meta_template_name`
   (parameter order is in `META_TEMPLATE_PARAMS`). Without a template name the message is sent
   as free text, which Meta only delivers inside the 24-hour window.
4. Evolution is not ported yet, so every stay message goes out on Meta for now.

## Sends that do not wait for the cron

- **New registration with a mobile number** (or a corrected number): the scheduler runs at once, so the
  form-link message goes out immediately. Inside the 09:00 to 20:00 IST window only; outside it the message
  waits until 09:00 (PDR rule).
- **While staff use the app**, opening the Stays list also runs the scheduler (at most once a minute).
- **ID rejected:** the guest gets a WhatsApp straight away with the reason and the link to upload again,
  at any hour. If it cannot be sent (number paused or disconnected) staff get a notification to message the
  guest by hand.
- The external cron above is still needed for the quiet hours and for timed messages (reminders the day
  before, check-out, review) when nobody has the app open.
