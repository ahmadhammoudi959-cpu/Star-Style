import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import http from "node:http";
import { eq } from "drizzle-orm";
import {
  formatPhone, graphErrorCode, normalizePhone, parseWaSettings, parseWebhook, statusAfter, templateParams, validSignature, waReady, windowLeftMs, windowOpen,
} from "../src/lib/whatsapp-rules";

// WhatsApp im System (Wunsch Inhaber 16.11.2026)
const PHONE_ID = "1234567890123", WABA = "9876543210987";
const hook = (o: { messages?: unknown[]; statuses?: unknown[]; contacts?: unknown[]; phoneId?: string }) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "491785571725", phone_number_id: o.phoneId ?? PHONE_ID }, contacts: o.contacts ?? [], messages: o.messages ?? [], statuses: o.statuses ?? [] } }] }],
});

describe("WhatsApp – reine Regeln", () => {
  it("Telefonnummern → WhatsApp-ID", () => {
    expect(normalizePhone("+49 178 557 17 25")).toBe("491785571725");
    expect(normalizePhone("0049 (178) 5571725")).toBe("491785571725");
    expect(normalizePhone("0178/5571725")).toBe("491785571725");
    expect(normalizePhone("+31 6 12345678")).toBe("31612345678");
    expect(normalizePhone("12")).toBe("");
    expect(normalizePhone("")).toBe("");
    expect(formatPhone("491785571725")).toBe("+49 178 5571725");
  });

  it("24-Stunden-Fenster", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(windowOpen(null, now)).toBe(false);
    expect(windowOpen("2026-11-15T12:00:01Z", now)).toBe(true);
    expect(windowOpen("2026-11-15T11:59:59Z", now)).toBe(false);
    expect(windowLeftMs("2026-11-16T11:00:00Z", now)).toBe(23 * 3600 * 1000);
  });

  it("Signatur: nur mit dem richtigen App-Geheimnis und unverändertem Inhalt", () => {
    const body = Buffer.from('{"a":1}');
    const sig = "sha256=" + createHmac("sha256", "geheim").update(body).digest("hex");
    expect(validSignature(body, sig, "geheim")).toBe(true);
    expect(validSignature(Buffer.from('{"a":2}'), sig, "geheim")).toBe(false);
    expect(validSignature(body, sig, "anders")).toBe(false);
    expect(validSignature(body, null, "geheim")).toBe(false);
    expect(validSignature(body, "sha256=zz", "geheim")).toBe(false);
  });

  it("Webhook lesen: Text, Bild, Standort, Reaktion, Status – nur für unsere Nummer", () => {
    const p = hook({
      contacts: [{ wa_id: "491785551234", profile: { name: "Salon Amal" } }],
      messages: [
        { from: "491785551234", id: "wamid.1", timestamp: "1763290800", type: "text", text: { body: "Hallo" } },
        { from: "491785551234", id: "wamid.2", timestamp: "1763290801", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "Foto" } },
        { from: "491785551234", id: "wamid.3", timestamp: "1763290802", type: "location", location: { latitude: 51.6, longitude: 7.3, name: "Lager" } },
        { from: "491785551234", id: "wamid.4", timestamp: "1763290803", type: "reaction", reaction: { message_id: "wamid.out1", emoji: "👍" } },
      ],
      statuses: [{ id: "wamid.out1", status: "failed", timestamp: "1763290804", errors: [{ code: 131047, title: "Re-engagement message" }] }],
    });
    const r = parseWebhook(p, PHONE_ID);
    expect(r.messages.map((m) => [m.type, m.body, m.name])).toEqual([
      ["text", "Hallo", "Salon Amal"], ["image", "Foto", "Salon Amal"], ["location", "Lager · https://maps.google.com/?q=51.6,7.3", "Salon Amal"], ["reaction", "👍", "Salon Amal"],
    ]);
    expect(r.messages[1]).toMatchObject({ mediaId: "m1", mediaMime: "image/jpeg" });
    expect(r.messages[3].replyTo).toBe("wamid.out1");
    expect(r.statuses).toEqual([{ wamid: "wamid.out1", status: "failed", at: new Date(1763290804000), error: "131047 Re-engagement message" }]);
    expect(parseWebhook(hook({ messages: [{ from: "1", id: "x", type: "text", text: { body: "fremd" } }], phoneId: "999" }), PHONE_ID).messages).toEqual([]);
    expect(parseWebhook({ object: "page" }, PHONE_ID)).toEqual({ messages: [], statuses: [] });
  });

  it("Status nur vorwärts, Fehler verständlich, Vorlagen-Platzhalter, Einstellungen", () => {
    expect(statusAfter("read", "delivered")).toBe("read");
    expect(statusAfter("sent", "delivered")).toBe("delivered");
    expect(statusAfter("delivered", "failed")).toBe("failed");
    expect(graphErrorCode({ code: 131047 }, 400)).toBe("window");
    expect(graphErrorCode({ code: 190 }, 401)).toBe("auth");
    expect(graphErrorCode(undefined, 503)).toBe("network");
    expect(templateParams("Hallo {{1}}, Ihre Bestellung {{2}} ist da.")).toBe(2);
    expect(templateParams("Hallo")).toBe(0);
    const s = parseWaSettings({ phoneNumberId: "abc", apiVersion: "v9" });
    expect(s).toMatchObject({ phoneNumberId: "", apiVersion: "v24.0" });
    expect(waReady(s)).toBe(false);
  });
});

const run = process.env.DATABASE_URL && process.env.SESSION_SECRET ? describe : describe.skip;

run("WhatsApp – mit simulierter Meta-API (Datenbank)", () => {
  const SECRET = "app-secret-test", TOKEN = "EAAtest-token";
  const got: { method: string; path: string; body: unknown; auth: string }[] = [];
  let server: http.Server;
  let port = 0;
  let wa: typeof import("../src/lib/whatsapp");
  let before: unknown;
  let customerId = "";
  const sign = (b: Buffer) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex");
  const post = async (payload: unknown, sig?: string) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return wa.handleWhatsappWebhook(raw, sig ?? sign(raw));
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const path = (req.url ?? "").split("?")[0];
        let body: unknown = raw.toString("utf8");
        try { body = JSON.parse(raw.toString("utf8")); } catch { /* multipart */ }
        got.push({ method: req.method ?? "", path, body, auth: String(req.headers.authorization ?? "") });
        const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 190, message: "Invalid OAuth access token" } });
        if (path === `/v24.0/${PHONE_ID}` && req.method === "GET") return json(200, { display_phone_number: "+49 178 5571725", verified_name: "Star Style", quality_rating: "GREEN" });
        if (path === `/v24.0/${PHONE_ID}/media`) return json(200, { id: "media-out-1" });
        if (path === `/v24.0/${PHONE_ID}/messages`) {
          const b = body as { status?: string; to?: string };
          if (b.status === "read") return json(200, { success: true });
          if (b.to === "4900000000000") return json(400, { error: { code: 131026, message: "Message undeliverable" } });
          return json(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.out${got.length}` }] });
        }
        if (path === `/v24.0/${WABA}/message_templates`) return json(200, { data: [
          { name: "hallo_kunde", language: "de", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hallo {{1}}, hier ist Star Style." }] },
          { name: "abgelehnt", language: "de", status: "REJECTED", components: [] },
        ] });
        if (path === "/v24.0/media-in-1") return json(200, { url: `http://127.0.0.1:${port}/dl/media-in-1`, mime_type: "image/jpeg", file_size: 3 });
        if (path === "/dl/media-in-1") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(Buffer.from([0xff, 0xd8, 0xff])); }
        json(404, { error: { code: 100, message: "not found" } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    process.env.WHATSAPP_GRAPH_URL = `http://127.0.0.1:${port}`;
    const { db, schema } = await import("../src/db");
    await db.insert(schema.companySettings).values({ id: "company", name: "Test GmbH" }).onConflictDoNothing();
    before = (await db.query.companySettings.findFirst())?.whatsapp;
    await db.delete(schema.waChats).where(eq(schema.waChats.waId, "491785551234"));
    await db.delete(schema.waChats).where(eq(schema.waChats.waId, "4900000000000"));
    // Kunde wird nur erkannt, wenn genau einer die Nummer hat → Testkunden früherer Läufe weg
    await db.delete(schema.customers).where(eq(schema.customers.name, "Salon Amal WA"));
    customerId = (await db.insert(schema.customers).values({ name: "Salon Amal WA", phone: "0178 555 1234" }).returning())[0].id;
    wa = await import("../src/lib/whatsapp");
  });

  afterAll(async () => {
    const { db, schema } = await import("../src/db");
    await db.update(schema.companySettings).set({ whatsapp: (before ?? {}) as Record<string, unknown> }).where(eq(schema.companySettings.id, "company"));
    await db.delete(schema.waChats).where(eq(schema.waChats.waId, "491785551234"));
    await db.delete(schema.waChats).where(eq(schema.waChats.waId, "4900000000000"));
    await db.delete(schema.customers).where(eq(schema.customers.name, "Salon Amal WA"));
    delete process.env.WHATSAPP_GRAPH_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("Einstellungen: verschlüsselt, Prüfwort erzeugt, Verbindung geprüft", async () => {
    expect(await wa.saveWaSettings({ phoneNumberId: "12x", wabaId: "", accessToken: TOKEN, appSecret: SECRET, apiVersion: "v24.0" })).toEqual({ problem: "phoneNumberId" });
    expect(await wa.saveWaSettings({ phoneNumberId: PHONE_ID, wabaId: WABA, accessToken: TOKEN, appSecret: SECRET, apiVersion: "v24.0" })).toEqual({ ok: true });
    const s = await wa.loadWaSettings();
    expect(s.accessToken).not.toContain(TOKEN);
    expect(s.appSecret).not.toContain(SECRET);
    expect(s.verifyToken.length).toBeGreaterThan(10);
    expect(await wa.verifyWebhook("subscribe", s.verifyToken)).toBe(true);
    expect(await wa.verifyWebhook("subscribe", "falsch")).toBe(false);
    expect(await wa.testWhatsapp()).toEqual({ ok: true, displayPhone: "+49 178 5571725", verifiedName: "Star Style", quality: "GREEN" });
    // Prüfwort bleibt beim erneuten Speichern gleich (Meta muss nichts neu bekommen); leere Geheimnisse = alte bleiben
    await wa.saveWaSettings({ phoneNumberId: PHONE_ID, wabaId: WABA, accessToken: "", appSecret: "", apiVersion: "v24.0" });
    expect((await wa.loadWaSettings()).verifyToken).toBe(s.verifyToken);
    expect((await wa.testWhatsapp()).ok).toBe(true);
    const { db, schema } = await import("../src/db");
    const log = await db.query.auditLog.findMany({ where: eq(schema.auditLog.entityId, "whatsapp") });
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    expect(JSON.stringify(log)).not.toContain(SECRET);
  });

  it("eingehend: falsche Signatur abgelehnt; Text + Bild gespeichert, Kunde erkannt, doppelte Meldung ignoriert", async () => {
    const p = hook({
      contacts: [{ wa_id: "491785551234", profile: { name: "Amal" } }],
      messages: [
        { from: "491785551234", id: "wamid.in1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Habt ihr Färbeschalen?" } },
        { from: "491785551234", id: "wamid.in2", timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "media-in-1", mime_type: "image/jpeg" } },
      ],
    });
    expect((await post(p, "sha256=00")).status).toBe(401);
    expect(await post(p)).toEqual({ status: 200, reason: "ok" });
    expect(await post(p)).toEqual({ status: 200, reason: "ok" }); // Meta wiederholt
    const { db, schema } = await import("../src/db");
    const chat = (await db.query.waChats.findFirst({ where: eq(schema.waChats.waId, "491785551234") }))!;
    expect(chat).toMatchObject({ name: "Amal", unread: 2, customerId });
    const msgs = await db.query.waMessages.findMany({ where: eq(schema.waMessages.chatId, chat.id) });
    expect(msgs).toHaveLength(2);
    // gleiche Sekunde (Meta liefert nur Sekunden) → Reihenfolge wie gesendet
    expect((await wa.chatThread(chat.id))!.messages.map((m) => m.waMessageId)).toEqual(["wamid.in1", "wamid.in2"]);
    // Bild wird im Hintergrund geladen
    let img = msgs.find((m) => m.type === "image")!;
    for (let i = 0; i < 40 && !img.mediaFileId; i++) { await new Promise((r) => setTimeout(r, 100)); img = (await db.query.waMessages.findFirst({ where: eq(schema.waMessages.id, img.id) }))!; }
    expect(img.mediaFileId).toBeTruthy();
    const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, img.mediaFileId!) });
    expect(f?.mime).toBe("image/jpeg");
    expect(f?.size).toBe(3);
    expect(await wa.waUnread()).toBeGreaterThanOrEqual(2);
  });

  it("senden im Fenster, Status vorwärts, gelesen; außerhalb nur Vorlage", async () => {
    const { db, schema } = await import("../src/db");
    const chat = (await db.query.waChats.findFirst({ where: eq(schema.waChats.waId, "491785551234") }))!;
    const m = await wa.sendWaText(chat.id, "Ja, 10 Stück sind da.", undefined);
    const req = got.findLast((g) => g.path.endsWith("/messages"))!;
    expect(req.body).toMatchObject({ to: "491785551234", type: "text", text: { body: "Ja, 10 Stück sind da." } });
    expect(m.status).toBe("pending");
    await post(hook({ statuses: [{ id: m.waMessageId, status: "read", timestamp: "1" }] }));
    await post(hook({ statuses: [{ id: m.waMessageId, status: "delivered", timestamp: "2" }] })); // kommt verspätet – bleibt „gelesen“
    expect((await db.query.waMessages.findFirst({ where: eq(schema.waMessages.id, m.id) }))!.status).toBe("read");

    await wa.markChatRead(chat.id);
    expect((await db.query.waChats.findFirst({ where: eq(schema.waChats.id, chat.id) }))!.unread).toBe(0);
    expect(got.findLast((g) => g.path.endsWith("/messages"))!.body).toMatchObject({ status: "read", message_id: "wamid.in2" });

    const file = await wa.sendWaFile(chat.id, { name: "Angebot.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4") }, "Angebot");
    expect(file.mediaFileId).toBeTruthy();
    expect(got.findLast((g) => g.path.endsWith("/messages"))!.body).toMatchObject({ type: "document", document: { id: "media-out-1", filename: "Angebot.pdf", caption: "Angebot" } });
    await expect(wa.sendWaFile(chat.id, { name: "x.png", type: "image/png", data: Buffer.alloc(6 * 1024 * 1024) }, "")).rejects.toMatchObject({ code: "tooLarge" });

    // neuer Chat ohne Kundennachricht: nur Vorlage
    const id = await wa.openChat("+4900000000000");
    await expect(wa.sendWaText(id, "Hallo")).rejects.toMatchObject({ code: "window" });
    const tpl = await wa.listTemplates(true);
    expect(tpl).toEqual([{ name: "hallo_kunde", language: "de", category: "UTILITY", body: "Hallo {{1}}, hier ist Star Style.", params: 1 }]);
    await expect(wa.sendWaTemplate(id, { name: "hallo_kunde", language: "de", params: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(wa.sendWaTemplate(id, { name: "hallo_kunde", language: "de", params: ["Amal"] })).rejects.toMatchObject({ code: "undeliverable" });
    const ok = await wa.sendWaTemplate(chat.id, { name: "hallo_kunde", language: "de", params: ["Amal"] });
    expect(ok.body).toBe("Hallo Amal, hier ist Star Style.");
    expect(got.findLast((g) => g.path.endsWith("/messages"))!.body).toMatchObject({ type: "template", template: { name: "hallo_kunde", language: { code: "de" }, components: [{ type: "body", parameters: [{ type: "text", text: "Amal" }] }] } });
  });

  it("Zugang entfernen", async () => {
    await wa.saveWaSettings({ phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "", apiVersion: "", disconnect: true });
    expect(await wa.waConfigured()).toBe(false);
    expect((await post(hook({}))).status).toBe(503);
  });
});
