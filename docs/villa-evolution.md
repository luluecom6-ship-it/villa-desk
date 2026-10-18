# WhatsApp app number via Evolution API

Guest messages go out from the villa's own WhatsApp number, linked like WhatsApp Web
(Evolution API v2, Baileys). Meta Cloud API is parked; the code stays and can be switched
back on per property (`properties.default_channel`).

> **Risk.** This is unofficial WhatsApp. Use a dedicated SIM, never a personal number.
> The app starts slowly (20 messages a day, growing over three weeks) and stops by itself
> if sending fails or WhatsApp refuses the number. It lowers the risk of a ban, not to zero.

## 1. Run Evolution on a small server

Any VPS with Docker and a domain with HTTPS (Caddy or nginx in front). Example `docker-compose.yml`:

```yaml
services:
  evolution:
    image: atendai/evolution-api:v2.2.3
    restart: always
    ports: ["127.0.0.1:8080:8080"]
    environment:
      SERVER_URL: https://evo.example.com
      AUTHENTICATION_API_KEY: change-me-long-random      # the global key
      DATABASE_ENABLED: "true"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evo:evo@postgres:5432/evo
      CACHE_REDIS_ENABLED: "false"
      CACHE_LOCAL_ENABLED: "true"
      CONFIG_SESSION_PHONE_CLIENT: Villa Guest Desk
    volumes: ["evo_instances:/evolution/instances"]
    depends_on: [postgres]
  postgres:
    image: postgres:15
    restart: always
    environment: { POSTGRES_USER: evo, POSTGRES_PASSWORD: evo, POSTGRES_DB: evo }
    volumes: ["evo_pg:/var/lib/postgresql/data"]
volumes: { evo_instances: {}, evo_pg: {} }
```

Pin the image version you tested. Back up the two volumes: they hold the linked session.

## 2. Vercel environment variables

| Name | Value |
|---|---|
| `EVOLUTION_BASE_URL` | `https://evo.example.com` |
| `EVOLUTION_API_KEY` | the global key above (server only, never in the browser) |
| `NEXT_PUBLIC_SITE_URL` | your app's public URL (used to build the webhook URL) |
| `ENCRYPTION_KEY` | already set; encrypts each account's instance token |

Each account gets its own instance with its own token. The global key is used only to
create it.

## 3. Apply the database migration

Run `supabase/migrations/056_evolution_channel.sql` (after 052 to 055) in the Supabase SQL editor.

## 4. Link the number

Open **Settings → WhatsApp link** (admin) on the villa phone.

- **Scan QR:** WhatsApp → Linked devices → Link a device → scan.
- **Use pairing code:** type the phone's number, get an 8-character code, then WhatsApp →
  Linked devices → Link a device → Link with phone number instead.

The status card shows Not linked, Waiting for scan, Connected, Paused or Logged out. Then press
**Send test message**: it goes to the linked number itself.

## What the app does and does not do

- Scheduled guest messages follow the PDR schedule, the 09:00 to 20:00 window (property time
  zone) and the warm-up limit (20/day through day 3, 40 through day 7, 70 through day 14, 100
  through day 21, then your maximum). Only registered, active stays are messaged (the allow-list
  is checked again at send time).
- A reply to a guest goes out on the channel the guest wrote to and is not counted against the
  daily limit.
- Auto-pause: 4 failures in the last 5 sends, or the number logged out (401) or refused (403). A
  banner appears on Stays and admins get a notification. Messages stay queued. Press **Resume**
  after checking the number.
- While paused, disconnected or over the limit, scheduled messages wait. They are not failed
  and no attempt is used up.
- Inbound: READY / 1 / 2 and "other" alerts work as in the Meta flow. Flows, automations and the
  AI bot do not run on this channel. Unregistered numbers are silenced while villa mode is on.
- Logs hold event names, one-word outcomes and the last 4 digits of a number. No message text,
  no full numbers, nothing is auto-deleted.
- Media from the inbox is sent from a public URL; guest media sent to the number is not stored
  yet (text only).

## Troubleshooting

- *"The Evolution server is not set up"*: set the two env vars and redeploy.
- *Status stuck on Waiting*: the webhook cannot reach the app. Check `NEXT_PUBLIC_SITE_URL` and
  that the app is not behind a login wall for `/api/evolution/webhook/*`.
- *Instance already exists*: someone created `villa-<id>` by hand. Delete it on the Evolution
  server (the app never takes over an instance it did not create).
