import { describe, expect, it } from "vitest";
import { mapStatus, normalizeUpdates, normalizeUpsert, pickPhone } from "./normalize";

const key = (over: Record<string, unknown> = {}) => ({ remoteJid: "966546182300@s.whatsapp.net", fromMe: false, id: "3EB0ABC", ...over });

describe("normalizeUpsert", () => {
  it("reads a plain text message", () => {
    const n = normalizeUpsert({ key: key(), pushName: "Samia", message: { conversation: "Hello" }, messageType: "conversation", messageTimestamp: 1760000000 });
    expect(n).toMatchObject({ kind: "message", id: "3EB0ABC", phone: "966546182300", fromMe: false, type: "text", text: "Hello", pushName: "Samia", timestamp: "1760000000" });
  });

  it("reads extended text with a quoted message", () => {
    const n = normalizeUpsert({ key: key(), message: { extendedTextMessage: { text: "yes", contextInfo: { stanzaId: "PARENT1" } } } });
    expect(n).toMatchObject({ type: "text", text: "yes", quotedId: "PARENT1" });
  });

  it("reads an image with caption and inline base64", () => {
    const n = normalizeUpsert({ key: key(), message: { imageMessage: { caption: "receipt", mimetype: "image/jpeg" }, base64: "AAAA" } });
    expect(n).toMatchObject({ type: "image", text: "receipt", media: { mimetype: "image/jpeg", base64: "AAAA", fileName: null } });
  });

  it("unwraps ephemeral and document-with-caption wrappers", () => {
    const n = normalizeUpsert({
      key: key(),
      message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "bill.pdf", mimetype: "application/pdf", caption: "my bill" } } } } } },
    });
    expect(n).toMatchObject({ type: "document", text: "my bill", media: { fileName: "bill.pdf", mimetype: "application/pdf" } });
  });

  it("reads reactions, locations and native button replies", () => {
    expect(normalizeUpsert({ key: key(), message: { reactionMessage: { key: { id: "OURMSG" }, text: "👍" } } })).toMatchObject({
      type: "reaction",
      reaction: { targetId: "OURMSG", emoji: "👍" },
    });
    expect(normalizeUpsert({ key: key(), message: { locationMessage: { degreesLatitude: 21.5, degreesLongitude: 39.2, name: "Home" } } })).toMatchObject({
      type: "location",
      text: "Home - 21.5,39.2",
    });
    expect(normalizeUpsert({ key: key(), message: { buttonsResponseMessage: { selectedButtonId: "b1", selectedDisplayText: "Yes" } } })).toMatchObject({
      type: "reply",
      reply: { id: "b1", title: "Yes" },
    });
  });

  it("marks messages typed on the phone as fromMe", () => {
    expect(normalizeUpsert({ key: key({ fromMe: true }), message: { conversation: "on my way" } })).toMatchObject({ fromMe: true, phone: "966546182300" });
  });

  it("ignores groups, status, protocol messages and missing ids", () => {
    expect(normalizeUpsert({ key: key({ remoteJid: "1203630@g.us" }), message: { conversation: "x" } })).toMatchObject({ kind: "ignore" });
    expect(normalizeUpsert({ key: key({ remoteJid: "status@broadcast" }), message: { conversation: "x" } })).toMatchObject({ kind: "ignore" });
    expect(normalizeUpsert({ key: key(), message: { protocolMessage: { type: 0 } } })).toMatchObject({ kind: "ignore" });
    expect(normalizeUpsert({ key: { remoteJid: "966546182300@s.whatsapp.net" }, message: { conversation: "x" } })).toMatchObject({ kind: "ignore" });
  });

  it("labels unknown types instead of dropping them", () => {
    expect(normalizeUpsert({ key: key(), message: { pollCreationMessage: {} }, messageType: "pollCreationMessage" })).toMatchObject({
      type: "unknown",
      text: "[Unsupported message type: pollCreationMessage]",
    });
  });
});

describe("pickPhone", () => {
  it("prefers the phone number when the chat is addressed by LID", () => {
    expect(pickPhone({ remoteJid: "12345@lid", remoteJidAlt: "966500000001@s.whatsapp.net" }, {})).toEqual({ phone: "966500000001", lid: "12345" });
    expect(pickPhone({ remoteJid: "12345@lid", senderPn: "966500000002@s.whatsapp.net" }, {})).toEqual({ phone: "966500000002", lid: "12345" });
  });
  it("returns no phone when only a LID is known", () => {
    expect(pickPhone({ remoteJid: "12345@lid" }, {})).toEqual({ phone: null, lid: "12345" });
  });
});

describe("statuses", () => {
  it("maps names and numbers", () => {
    expect(mapStatus("DELIVERY_ACK")).toBe("delivered");
    expect(mapStatus("READ")).toBe("read");
    expect(mapStatus("PLAYED")).toBe("read");
    expect(mapStatus(3)).toBe("delivered");
    expect(mapStatus("PENDING")).toBeNull();
  });
  it("normalizes both update shapes", () => {
    expect(normalizeUpdates({ keyId: "M1", remoteJid: "966546182300@s.whatsapp.net", fromMe: true, status: "READ" })).toEqual([
      { id: "M1", fromMe: true, status: "read", phone: "966546182300" },
    ]);
    expect(normalizeUpdates([{ key: { id: "M2", remoteJid: "966546182300@s.whatsapp.net", fromMe: true }, update: { status: 3 } }])).toEqual([
      { id: "M2", fromMe: true, status: "delivered", phone: "966546182300" },
    ]);
  });
});
