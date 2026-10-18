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
  form-link message goes out immediately, at any hour (owner decision: the first form link is exempt from the
  09:00 to 20:00 window; the WhatsApp number's daily limit still applies). Every other guest message still
  waits for 09:00.
- **While staff use the app**, opening the Stays list also runs the scheduler (at most once a minute).
- **ID rejected:** the guest gets a WhatsApp straight away with the reason and the link to upload again,
  at any hour. If it cannot be sent (number paused or disconnected) staff get a notification to message the
  guest by hand.
- The external cron above is still needed for the quiet hours and for timed messages (reminders the day
  before, check-out, review) when nobody has the app open.

## Guest messages that need a person (migration 058)

A guest message that is not READY / 1 / 2, and any message from an unregistered number while villa mode is on,
is chased: the first available caretaker gets a bell in the app and a WhatsApp from the villa number (if they
set an alert number in Settings -> Your profile). No reply (from the inbox or typed on the villa phone) within
the wait (default 10 minutes, set by an admin) -> the next available caretaker, and when none is left -> the
owner. Chasing is done by the scheduler, so **call the cron every minute** (not every 15) for the timing to be
accurate when nobody has the app open. A free external pinger such as cron-job.org is enough.

> Update 18 Oct 2026: the 09:00 to 20:00 window is removed. Every scheduled message goes out as soon as it is due, at any hour. The WhatsApp number's daily limit (warm-up) still applies.

## Answering guests from your own WhatsApp (migration 060)

Same idea as the Jwacrm agent relay. A guest's message is copied, with the guest's name, stay and a chat
number (#482), to the first available caretaker's **own WhatsApp** (Settings -> Your profile -> "Your
WhatsApp number"). The caretaker swipe-replies, and the answer goes to the guest from the villa number and is
saved in the inbox as an agent message (which stops the clock).

* Swipe-reply, or start with the number (`#482 on my way`), or just type if there is only one open chat.
* `/close` finish, `/transfer Sara`, `/info`, `/list`, `/off` and `/on` (duty), `/help`.
* A reply that cannot be matched to a guest is not sent; the agent is asked which chat it is.
* Not answered in time (default 10 min) -> the next caretaker gets the waiting messages and the first is told,
  then the owner. The caretaker who answered a guest last time gets that guest's next message first.
* Only text can be sent back for now (photos and voice notes from the agent are refused with a note).
* A team member's number is never a guest chat. Do not test by writing to the villa number from your own
  team number: it will be read as an answer, not a guest message. Use another phone.
