/**
 * Minimal Evolution API v2 client (Baileys integration). Server-side only.
 * Auth: `apikey` header — the instance token (preferred) or the server's global key.
 * The server address and global key come from env vars (EVOLUTION_BASE_URL, EVOLUTION_API_KEY),
 * never from the browser.
 */

export interface EvolutionConn {
  baseUrl: string;
  instance: string;
  apiKey: string;
}

export class EvolutionError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** Normalise a server URL: trim, drop trailing slashes, require http(s). */
export function normalizeBaseUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

async function call<T>(c: EvolutionConn, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: { apikey: c.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg =
        (json && typeof json === "object" && "response" in json
          ? JSON.stringify((json as { response: unknown }).response)
          : typeof json === "string"
            ? json
            : JSON.stringify(json)) || res.statusText;
      throw new EvolutionError(`Evolution ${method} ${path.split("?")[0]} → ${res.status}: ${String(msg).slice(0, 300)}`, res.status, json);
    }
    return json as T;
  } catch (e) {
    if (e instanceof EvolutionError) throw e;
    const reason = e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e);
    throw new EvolutionError(`Cannot reach Evolution at ${c.baseUrl} (${reason})`, 0);
  } finally {
    clearTimeout(t);
  }
}

const enc = encodeURIComponent;

export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export async function connectionState(c: EvolutionConn): Promise<ConnectionState> {
  const r = await call<{ instance?: { state?: string } }>(c, "GET", `/instance/connectionState/${enc(c.instance)}`);
  const s = r?.instance?.state;
  return s === "open" || s === "connecting" || s === "close" ? s : "unknown";
}

/** Instance details (owner number, profile name) — null if the instance does not exist. */
export async function fetchInstance(c: EvolutionConn): Promise<{ ownerJid: string | null; profileName: string | null; status: string | null } | null> {
  try {
    const r = await call<unknown>(c, "GET", `/instance/fetchInstances?instanceName=${enc(c.instance)}`);
    const list = Array.isArray(r) ? r : [];
    const row = list.find((x) => x && typeof x === "object" && ((x as { name?: string }).name === c.instance || (x as { instance?: { instanceName?: string } }).instance?.instanceName === c.instance)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const inst = (row.instance as Record<string, unknown> | undefined) ?? row;
    return {
      ownerJid: (inst.ownerJid as string) ?? (inst.owner as string) ?? null,
      profileName: (inst.profileName as string) ?? null,
      status: (inst.connectionStatus as string) ?? (inst.status as string) ?? null,
    };
  } catch (e) {
    if (e instanceof EvolutionError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

/** Create a Baileys instance with a token we choose (the instance's own apikey; it cannot touch other instances). */
export async function createInstance(c: EvolutionConn, token: string): Promise<void> {
  await call<unknown>(c, "POST", "/instance/create", {
    instanceName: c.instance,
    token,
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    syncFullHistory: false,
  });
}

/** Start/continue pairing: returns a QR image (data URL) and/or pairing code; empty when already connected. */
export async function connect(c: EvolutionConn, phoneNumber?: string): Promise<{ qr: string | null; pairingCode: string | null }> {
  // With `number`, Evolution also returns an 8-character pairing code (type it on the phone instead of scanning).
  const qs = phoneNumber ? `?number=${enc(phoneNumber.replace(/\D/g, ""))}` : "";
  const r = await call<{ base64?: string; code?: string; pairingCode?: string }>(c, "GET", `/instance/connect/${enc(c.instance)}${qs}`);
  return { qr: r?.base64 ?? null, pairingCode: r?.pairingCode ?? null };
}

export async function logout(c: EvolutionConn): Promise<void> {
  await call(c, "DELETE", `/instance/logout/${enc(c.instance)}`);
}

export const WEBHOOK_EVENTS = [
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
] as const;

/** Point the instance's webhook at WACRM (media sent inline as base64). */
export async function setWebhook(c: EvolutionConn, url: string): Promise<void> {
  await call(c, "POST", `/webhook/set/${enc(c.instance)}`, {
    webhook: { enabled: true, url, byEvents: false, base64: true, events: WEBHOOK_EVENTS },
  });
}

/** The URL the instance's webhook currently points at (null when none is set). */
export async function findWebhookUrl(c: EvolutionConn): Promise<string | null> {
  try {
    const r = await call<{ url?: string; enabled?: boolean; webhook?: { url?: string } } | null>(c, "GET", `/webhook/find/${enc(c.instance)}`);
    const url = r?.url ?? r?.webhook?.url ?? null;
    return typeof url === "string" && url.trim() ? url.trim() : null;
  } catch (e) {
    if (e instanceof EvolutionError && e.status === 404) return null;
    throw e;
  }
}

/** Send a plain text message. `number` = digits with country code. Returns the WhatsApp message id. */
export async function sendText(c: EvolutionConn, number: string, text: string, opts: { delayMs?: number } = {}): Promise<{ id: string | null }> {
  const r = await call<{ key?: { id?: string } }>(c, "POST", `/message/sendText/${enc(c.instance)}`, {
    number: number.replace(/\D/g, ""),
    text,
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
  });
  return { id: r?.key?.id ?? null };
}

const digits = (n: string) => n.replace(/\D/g, "");

/** Send an image / video / document by public URL, with an optional caption. */
export async function sendMedia(
  c: EvolutionConn,
  number: string,
  m: { kind: "image" | "video" | "document"; url: string; caption?: string; fileName?: string; mimetype?: string; delayMs?: number },
): Promise<{ id: string | null }> {
  const r = await call<{ key?: { id?: string } }>(c, "POST", `/message/sendMedia/${enc(c.instance)}`, {
    number: digits(number),
    mediatype: m.kind,
    media: m.url,
    ...(m.caption ? { caption: m.caption } : {}),
    ...(m.fileName ? { fileName: m.fileName } : {}),
    ...(m.mimetype ? { mimetype: m.mimetype } : {}),
    ...(m.delayMs ? { delay: m.delayMs } : {}),
  }, 60_000);
  return { id: r?.key?.id ?? null };
}

/** Send a voice note (the audio is converted by Evolution). */
export async function sendAudio(c: EvolutionConn, number: string, url: string): Promise<{ id: string | null }> {
  const r = await call<{ key?: { id?: string } }>(c, "POST", `/message/sendWhatsAppAudio/${enc(c.instance)}`, { number: digits(number), audio: url }, 60_000);
  return { id: r?.key?.id ?? null };
}

/** React to a message (empty emoji removes the reaction). */
export async function sendReaction(c: EvolutionConn, key: { remoteJid: string; fromMe: boolean; id: string }, emoji: string): Promise<void> {
  await call(c, "POST", `/message/sendReaction/${enc(c.instance)}`, { key, reaction: emoji });
}

/** Show "typing…" for `delayMs` (best effort). */
export async function sendPresence(c: EvolutionConn, number: string, delayMs = 3000): Promise<void> {
  await call(c, "POST", `/chat/sendPresence/${enc(c.instance)}`, { number: digits(number), presence: "composing", delay: delayMs }, delayMs + 10_000);
}

/** Mark inbound messages as read (blue ticks). */
export async function markRead(c: EvolutionConn, keys: { remoteJid: string; fromMe: boolean; id: string }[]): Promise<void> {
  await call(c, "POST", `/chat/markMessageAsRead/${enc(c.instance)}`, { readMessages: keys });
}

/** Download a received media message as base64 (when the webhook did not include it). */
export async function getBase64FromMedia(c: EvolutionConn, messageId: string): Promise<{ base64: string | null; mimetype: string | null; fileName: string | null }> {
  const r = await call<{ base64?: string; mimetype?: string; fileName?: string }>(
    c,
    "POST",
    `/chat/getBase64FromMediaMessage/${enc(c.instance)}`,
    { message: { key: { id: messageId } }, convertToMp4: false },
    60_000,
  );
  return { base64: r?.base64 ?? null, mimetype: r?.mimetype ?? null, fileName: r?.fileName ?? null };
}

/** "966501234567" → "966501234567@s.whatsapp.net" */
export const userJid = (number: string) => `${digits(number)}@s.whatsapp.net`;

/** "966501234567@s.whatsapp.net" → "966501234567" */
export const jidDigits = (jid: string | null | undefined) => (jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
