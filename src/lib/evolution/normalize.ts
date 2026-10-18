/**
 * Evolution API (Baileys) webhook payloads → a small, channel-neutral shape the inbox pipeline
 * understands. Pure functions only (tested in normalize.test.ts).
 *
 *   messages.upsert  data = { key: { remoteJid, fromMe, id, remoteJidAlt?, senderPn? }, pushName,
 *                             message: { conversation | extendedTextMessage | imageMessage | … ,
 *                                        base64? }, messageType, messageTimestamp }
 *   messages.update  data = { keyId, remoteJid, fromMe, status: 'DELIVERY_ACK' | 'READ' | … }
 *                    (older builds: { key: { id, … }, update: { status: 3 } }, sometimes an array)
 *
 * Groups, status stories, channels/newsletters and broadcast lists are ignored — the CRM is
 * one-to-one customer chat.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export type InboundKind = "text" | "image" | "video" | "document" | "audio" | "sticker" | "location" | "reaction" | "contact" | "reply" | "unknown";

export interface NormalizedMessage {
  kind: "message";
  id: string;
  fromMe: boolean;
  /** Customer phone digits (country code, no +); null when only a LID is known. */
  phone: string | null;
  /** WhatsApp "LID" (privacy id) when the chat is addressed by it. */
  lid: string | null;
  /** Sender's WhatsApp profile name (only meaningful when !fromMe). */
  pushName: string | null;
  /** Unix seconds, as a string (Meta's format). */
  timestamp: string;
  type: InboundKind;
  /** Text, caption, or a readable summary (location, contact). */
  text: string | null;
  media?: { mimetype: string | null; fileName: string | null; base64: string | null };
  reaction?: { targetId: string; emoji: string };
  /** A native button / list tap (older Baileys clients still send these). */
  reply?: { id: string; title: string };
  /** The message this one quotes (swipe-reply). */
  quotedId: string | null;
  rawType: string;
}

export type Normalized = NormalizedMessage | { kind: "ignore"; reason: string };

const IGNORED_JID = /@g\.us$|@broadcast$|@newsletter$|^status@/;

/** Peel wrappers (ephemeral, view-once, document-with-caption…) off a Baileys message. */
export function unwrapMessage(m: unknown): Obj {
  let cur: Obj = isObj(m) ? m : {};
  for (let i = 0; i < 5; i++) {
    const inner =
      (isObj(cur.ephemeralMessage) && cur.ephemeralMessage.message) ||
      (isObj(cur.viewOnceMessage) && cur.viewOnceMessage.message) ||
      (isObj(cur.viewOnceMessageV2) && cur.viewOnceMessageV2.message) ||
      (isObj(cur.viewOnceMessageV2Extension) && cur.viewOnceMessageV2Extension.message) ||
      (isObj(cur.documentWithCaptionMessage) && cur.documentWithCaptionMessage.message) ||
      null;
    if (!isObj(inner)) break;
    cur = { ...inner, base64: cur.base64 ?? inner.base64 };
  }
  return cur;
}

/** The customer's phone digits from a key, preferring a real number over a LID. */
export function pickPhone(key: Obj, data: Obj): { phone: string | null; lid: string | null } {
  const candidates = [key.remoteJid, key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt].map(str).filter((x): x is string => !!x);
  const pn = candidates.find((j) => /@s\.whatsapp\.net$/.test(j) || /@c\.us$/.test(j));
  const lid = candidates.find((j) => /@lid$/.test(j)) ?? null;
  const digits = pn ? pn.split("@")[0].split(":")[0].replace(/\D/g, "") : "";
  return { phone: digits.length >= 8 ? digits : null, lid: lid ? lid.split("@")[0] : null };
}

function tsSeconds(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : isObj(v) && typeof v.low === "number" ? v.low : NaN;
  const secs = Number.isFinite(n) && n > 0 ? (n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)) : Math.floor(Date.now() / 1000);
  return String(secs);
}

const contextOf = (m: Obj): string | null => {
  for (const v of Object.values(m)) {
    if (isObj(v) && isObj(v.contextInfo)) {
      const id = str(v.contextInfo.stanzaId);
      if (id) return id;
    }
  }
  return null;
};

/** messages.upsert `data` → normalized message (or why it is ignored). */
export function normalizeUpsert(dataIn: unknown): Normalized {
  const data = isObj(dataIn) ? dataIn : {};
  const key = isObj(data.key) ? data.key : {};
  const id = str(key.id);
  const remoteJid = str(key.remoteJid) ?? "";
  if (!id) return { kind: "ignore", reason: "no message id" };
  if (IGNORED_JID.test(remoteJid)) return { kind: "ignore", reason: "group / status / channel" };

  const m = unwrapMessage(data.message);
  if (isObj(m.protocolMessage)) return { kind: "ignore", reason: "protocol (delete / edit / settings)" };
  const onlySystemKeys = Object.keys(m).every((k) => ["senderKeyDistributionMessage", "messageContextInfo", "base64"].includes(k));
  if (m.pollUpdateMessage || (m.senderKeyDistributionMessage && onlySystemKeys)) {
    return { kind: "ignore", reason: "system message" };
  }

  const { phone, lid } = pickPhone(key, data);
  const base: Omit<NormalizedMessage, "type" | "text"> = {
    kind: "message",
    id,
    fromMe: key.fromMe === true,
    phone,
    lid,
    pushName: str(data.pushName),
    timestamp: tsSeconds(data.messageTimestamp),
    quotedId: contextOf(m) ?? (isObj(data.contextInfo) ? str(data.contextInfo.stanzaId) : null),
    rawType: str(data.messageType) ?? Object.keys(m).find((k) => k !== "messageContextInfo" && k !== "base64") ?? "unknown",
  };
  const b64 = str(m.base64) ?? str(data.base64);
  const media = (x: Obj) => ({ mimetype: str(x.mimetype), fileName: str(x.fileName) ?? str(x.title), base64: b64 });

  if (str(m.conversation)) return { ...base, type: "text", text: str(m.conversation) };
  if (isObj(m.extendedTextMessage)) return { ...base, type: "text", text: str(m.extendedTextMessage.text) };
  if (isObj(m.imageMessage)) return { ...base, type: "image", text: str(m.imageMessage.caption), media: media(m.imageMessage) };
  if (isObj(m.videoMessage)) return { ...base, type: "video", text: str(m.videoMessage.caption), media: media(m.videoMessage) };
  if (isObj(m.ptvMessage)) return { ...base, type: "video", text: null, media: media(m.ptvMessage) };
  if (isObj(m.documentMessage)) {
    const d = m.documentMessage;
    return { ...base, type: "document", text: str(d.caption) ?? str(d.fileName) ?? str(d.title), media: media(d) };
  }
  if (isObj(m.audioMessage)) return { ...base, type: "audio", text: null, media: media(m.audioMessage) };
  if (isObj(m.stickerMessage)) return { ...base, type: "sticker", text: null, media: media(m.stickerMessage) };
  if (isObj(m.locationMessage) || isObj(m.liveLocationMessage)) {
    const l = (m.locationMessage ?? m.liveLocationMessage) as Obj;
    const text = [str(l.name), str(l.address), `${l.degreesLatitude},${l.degreesLongitude}`].filter(Boolean).join(" - ");
    return { ...base, type: "location", text };
  }
  if (isObj(m.reactionMessage)) {
    const r = m.reactionMessage;
    const target = isObj(r.key) ? str(r.key.id) : null;
    if (!target) return { kind: "ignore", reason: "reaction without target" };
    return { ...base, type: "reaction", text: str(r.text), reaction: { targetId: target, emoji: typeof r.text === "string" ? r.text : "" } };
  }
  if (isObj(m.buttonsResponseMessage)) {
    const r = m.buttonsResponseMessage;
    const rid = str(r.selectedButtonId) ?? str(r.selectedDisplayText);
    if (rid) return { ...base, type: "reply", text: str(r.selectedDisplayText) ?? rid, reply: { id: rid, title: str(r.selectedDisplayText) ?? rid } };
  }
  if (isObj(m.templateButtonReplyMessage)) {
    const r = m.templateButtonReplyMessage;
    const rid = str(r.selectedId) ?? str(r.selectedDisplayText);
    if (rid) return { ...base, type: "reply", text: str(r.selectedDisplayText) ?? rid, reply: { id: rid, title: str(r.selectedDisplayText) ?? rid } };
  }
  if (isObj(m.listResponseMessage)) {
    const r = m.listResponseMessage;
    const rid = isObj(r.singleSelectReply) ? str(r.singleSelectReply.selectedRowId) : null;
    if (rid) return { ...base, type: "reply", text: str(r.title) ?? rid, reply: { id: rid, title: str(r.title) ?? rid } };
  }
  if (isObj(m.contactMessage)) return { ...base, type: "contact", text: `[Contact] ${str(m.contactMessage.displayName) ?? ""}`.trim() };
  if (isObj(m.contactsArrayMessage)) return { ...base, type: "contact", text: "[Contacts]" };
  return { ...base, type: "unknown", text: `[Unsupported message type: ${base.rawType}]` };
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

const STATUS_NAMES: Record<string, DeliveryStatus | null> = {
  ERROR: "failed",
  PENDING: null,
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
};
const STATUS_NUMBERS: (DeliveryStatus | null)[] = ["failed", null, "sent", "delivered", "read", "read"];

export function mapStatus(s: unknown): DeliveryStatus | null {
  if (typeof s === "number") return STATUS_NUMBERS[s] ?? null;
  if (typeof s === "string") return STATUS_NAMES[s.toUpperCase()] ?? null;
  return null;
}

export interface NormalizedStatus {
  id: string;
  fromMe: boolean;
  status: DeliveryStatus;
  phone: string | null;
}

/** messages.update `data` (object or array) → delivery statuses for our own messages. */
export function normalizeUpdates(dataIn: unknown): NormalizedStatus[] {
  const list = Array.isArray(dataIn) ? dataIn : [dataIn];
  const out: NormalizedStatus[] = [];
  for (const d of list) {
    if (!isObj(d)) continue;
    const key = isObj(d.key) ? d.key : {};
    const id = str(d.keyId) ?? str(key.id);
    const status = mapStatus(d.status ?? (isObj(d.update) ? d.update.status : undefined));
    const remote = str(d.remoteJid) ?? str(key.remoteJid) ?? "";
    if (!id || !status || IGNORED_JID.test(remote)) continue;
    const fromMe = (d.fromMe ?? key.fromMe) === true;
    const digits = remote.endsWith("@s.whatsapp.net") ? remote.split("@")[0].replace(/\D/g, "") : null;
    out.push({ id, fromMe, status, phone: digits });
  }
  return out;
}
