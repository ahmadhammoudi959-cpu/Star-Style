import "server-only";
/**
 * WhatsApp im System (Wunsch Inhaber 16.11.2026: „يفتح الواتساب جوه الابلكيشن … المراسله تترسل من جوه السيستم“):
 * Meta WhatsApp Cloud API. Eingehend über den Webhook (/api/whatsapp/webhook, Signatur mit dem App-Geheimnis),
 * ausgehend über die Graph API mit dem dauerhaften Token des Systembenutzers. Freie Nachrichten nur im 24-Stunden-Fenster
 * nach der letzten Kundennachricht, sonst genehmigte Vorlagen. Reine Regeln: ./whatsapp-rules.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "./crypto";
import {
  formatPhone, graphErrorCode, MAX_DOC_BYTES, MAX_IMAGE_BYTES, normalizePhone, outgoingKind, parseWaSettings, parseWebhook, statusAfter,
  validMetaId, validSignature, validVersion, waReady, windowOpen, type WaSettings,
} from "./whatsapp-rules";

export class WaError extends Error {
  /** notConfigured | auth | window | undeliverable | notAllowed | template | rate | invalid | rejected | network | notFound | tooLarge | fileType */
  constructor(public code: string, message = code) { super(message); }
}

const GRAPH = () => (process.env.WHATSAPP_GRAPH_URL || "https://graph.facebook.com").replace(/\/+$/, "");

export async function loadWaSettings(): Promise<WaSettings> {
  const row = await db.query.companySettings.findFirst({ columns: { whatsapp: true } });
  return parseWaSettings(row?.whatsapp);
}

type Active = WaSettings & { token: string; secret: string };
async function active(): Promise<Active> {
  const s = await loadWaSettings();
  if (!waReady(s)) throw new WaError("notConfigured");
  try { return { ...s, token: decrypt(s.accessToken), secret: decrypt(s.appSecret) }; } catch { throw new WaError("notConfigured"); }
}
export const waConfigured = async () => { try { return waReady(await loadWaSettings()); } catch { return false; } };

export type WaSettingsInput = { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string; apiVersion: string; disconnect?: boolean };

/** Speichern: leere Geheimnisse = alte behalten; Prüfwort für den Webhook wird einmal erzeugt (bleibt, damit Meta es nicht neu braucht) */
export async function saveWaSettings(input: WaSettingsInput, userId?: string): Promise<{ ok: true } | { problem: "phoneNumberId" | "wabaId" | "accessToken" | "appSecret" | "apiVersion" }> {
  const phoneNumberId = input.phoneNumberId.trim(), wabaId = input.wabaId.trim(), apiVersion = input.apiVersion.trim() || "v24.0";
  if (!input.disconnect) {
    if (!validMetaId(phoneNumberId)) return { problem: "phoneNumberId" };
    if (wabaId && !validMetaId(wabaId)) return { problem: "wabaId" };
    if (!validVersion(apiVersion)) return { problem: "apiVersion" };
  }
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; whatsapp: unknown }>(sql`select id, whatsapp from company_settings order by id limit 1 for update`);
    const row = rows.rows[0];
    const before = parseWaSettings(row?.whatsapp);
    const accessToken = input.disconnect ? "" : input.accessToken.trim() ? encrypt(input.accessToken.trim().slice(0, 2000)) : before.accessToken;
    const appSecret = input.disconnect ? "" : input.appSecret.trim() ? encrypt(input.appSecret.trim().slice(0, 200)) : before.appSecret;
    if (!input.disconnect && !accessToken) return { problem: "accessToken" as const };
    if (!input.disconnect && !appSecret) return { problem: "appSecret" as const };
    const verifyToken = before.verifyToken || randomBytes(18).toString("base64url");
    const next = input.disconnect ? { verifyToken } : {
      phoneNumberId, wabaId, apiVersion, accessToken, appSecret, verifyToken,
      displayPhone: before.phoneNumberId === phoneNumberId ? before.displayPhone : "", verifiedName: before.phoneNumberId === phoneNumberId ? before.verifiedName : "",
    };
    if (row) await tx.update(schema.companySettings).set({ whatsapp: next }).where(eq(schema.companySettings.id, row.id));
    else await tx.insert(schema.companySettings).values({ id: "company", whatsapp: next });
    const show = (s: Partial<WaSettings>) => ({ phoneNumberId: s.phoneNumberId, wabaId: s.wabaId, apiVersion: s.apiVersion, accessToken: s.accessToken ? "gesetzt" : "", appSecret: s.appSecret ? "gesetzt" : "" });
    await tx.insert(schema.auditLog).values({
      entity: "settings", entityId: "whatsapp", action: input.disconnect ? "disconnect" : "update", userId: userId ?? null,
      before: show(before), after: { ...show(next as Partial<WaSettings>), tokenChanged: Boolean(input.accessToken.trim()), secretChanged: Boolean(input.appSecret.trim()) }, // nie Token/Geheimnis ins Protokoll
    });
    return { ok: true as const };
  });
}

async function graph<T = Record<string, unknown>>(s: Active, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  const form = typeof FormData !== "undefined" && body instanceof FormData;
  try {
    res = await fetch(`${GRAPH()}/${s.apiVersion}/${path}`, {
      method, cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${s.token}`, ...(body && !form ? { "Content-Type": "application/json" } : {}) },
      body: body == null ? undefined : form ? (body as FormData) : JSON.stringify(body),
    });
  } catch (e) { throw new WaError("network", (e as Error).message?.slice(0, 200)); }
  const text = await res.text();
  let json: { error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } } } & Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* kein JSON */ }
  if (!res.ok || json.error) throw new WaError(graphErrorCode(json.error, res.status), (json.error?.error_data?.details || json.error?.message || text).slice(0, 300));
  return json as T;
}

/** Verbindung prüfen: Nummer bei Meta abfragen (Anzeige-Nummer, Name, Qualität) – sendet nichts */
export async function testWhatsapp(): Promise<{ ok: true; displayPhone: string; verifiedName: string; quality: string } | { ok: false; code: string; message: string }> {
  try {
    const s = await active();
    const r = await graph<{ display_phone_number?: string; verified_name?: string; quality_rating?: string }>(s, "GET", `${s.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
    const displayPhone = String(r.display_phone_number ?? ""), verifiedName = String(r.verified_name ?? "");
    await db.execute(sql`update company_settings set whatsapp = whatsapp || ${JSON.stringify({ displayPhone, verifiedName })}::jsonb`);
    return { ok: true, displayPhone, verifiedName, quality: String(r.quality_rating ?? "") };
  } catch (e) {
    return e instanceof WaError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: "network", message: String(e).slice(0, 200) };
  }
}

/** Webhook-Bestätigung (GET): Meta schickt das Prüfwort aus den Einstellungen */
export async function verifyWebhook(mode: string | null, token: string | null): Promise<boolean> {
  if (mode !== "subscribe" || !token) return false;
  const s = await loadWaSettings();
  return Boolean(s.verifyToken) && token === s.verifyToken;
}

// ───────────────────────── Kunden ─────────────────────────

/** Kunde mit derselben Nummer (nur wenn genau einer passt – nie raten) */
async function customerFor(waId: string): Promise<string | null> {
  const rows = await db.select({ id: schema.customers.id, phone: schema.customers.phone }).from(schema.customers).where(sql`${schema.customers.phone} <> ''`);
  const hits = rows.filter((r) => normalizePhone(r.phone) === waId);
  return hits.length === 1 ? hits[0].id : null;
}

const preview = (type: string, body: string) => (body ? body.slice(0, 160) : `[${type}]`);

// ───────────────────────── Eingehend (Webhook) ─────────────────────────

/** Webhook (POST): Signatur prüfen, Nachrichten und Status speichern; Medien danach im Hintergrund laden */
export async function handleWhatsappWebhook(raw: Buffer, signature: string | null): Promise<{ status: number; reason: string }> {
  const s = await loadWaSettings();
  if (!waReady(s)) return { status: 503, reason: "notConfigured" };
  let secret = "";
  try { secret = decrypt(s.appSecret); } catch { return { status: 503, reason: "notConfigured" }; }
  if (!validSignature(raw, signature, secret)) return { status: 401, reason: "signature" };
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return { status: 400, reason: "json" }; }
  const { messages, statuses } = parseWebhook(payload, s.phoneNumberId);
  const media: { id: string; mediaId: string; mime: string; name: string }[] = [];
  for (const m of messages) {
    const newId = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into wa_chats (id, wa_id, name) values (${crypto.randomUUID()}, ${m.waId}, ${m.name}) on conflict (wa_id) do nothing`);
      const chat = await tx.query.waChats.findFirst({ where: eq(schema.waChats.waId, m.waId) });
      if (!chat) return null;
      const ins = await tx.insert(schema.waMessages).values({
        chatId: chat.id, waMessageId: m.wamid, direction: "in", type: m.type, body: m.body, mediaId: m.mediaId, mediaMime: m.mediaMime,
        mediaName: m.mediaName, status: "received", replyTo: m.replyTo, at: m.at,
      }).onConflictDoNothing().returning({ id: schema.waMessages.id });
      if (!ins.length) return null; // schon da (Meta wiederholt Meldungen)
      const later = !chat.lastMessageAt || chat.lastMessageAt <= m.at;
      await tx.update(schema.waChats).set({
        name: m.name || chat.name,
        lastInboundAt: !chat.lastInboundAt || chat.lastInboundAt < m.at ? m.at : chat.lastInboundAt,
        ...(later ? { lastMessageAt: m.at, lastText: preview(m.type, m.body) } : {}),
        unread: m.type === "reaction" ? chat.unread : chat.unread + 1,
      }).where(eq(schema.waChats.id, chat.id));
      return { id: ins[0].id, chatId: chat.id, linked: Boolean(chat.customerId) };
    });
    if (!newId) continue;
    if (!newId.linked) {
      const cust = await customerFor(m.waId).catch(() => null);
      if (cust) await db.update(schema.waChats).set({ customerId: cust }).where(and(eq(schema.waChats.id, newId.chatId), sql`${schema.waChats.customerId} is null`));
    }
    if (m.mediaId) media.push({ id: newId.id, mediaId: m.mediaId, mime: m.mediaMime, name: m.mediaName });
  }
  for (const st of statuses) {
    if (!st.wamid) continue;
    const cur = await db.query.waMessages.findFirst({ where: eq(schema.waMessages.waMessageId, st.wamid), columns: { id: true, status: true } });
    if (!cur) continue;
    const next = statusAfter(cur.status, st.status);
    if (next !== cur.status || st.error) await db.update(schema.waMessages).set({ status: next, ...(st.error ? { error: st.error } : {}) }).where(eq(schema.waMessages.id, cur.id));
  }
  forgetUnread();
  if (media.length) void downloadMedia(media).catch((e) => console.error("whatsapp media", e));
  return { status: 200, reason: "ok" };
}

/** Eingehende Medien von Meta holen (Link gilt nur ~5 min) und in stored_files ablegen */
async function downloadMedia(list: { id: string; mediaId: string; mime: string; name: string }[]) {
  const s = await active();
  for (const m of list) {
    try {
      const info = await graph<{ url?: string; mime_type?: string; file_size?: number }>(s, "GET", m.mediaId);
      if (!info.url) continue;
      if ((info.file_size ?? 0) > MAX_DOC_BYTES) { await db.update(schema.waMessages).set({ error: "tooLarge" }).where(eq(schema.waMessages.id, m.id)); continue; }
      const res = await fetch(info.url, { headers: { Authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(60_000), cache: "no-store" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOC_BYTES) continue;
      const mime = (info.mime_type || m.mime || "application/octet-stream").split(";")[0].trim();
      const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
      const [f] = await db.insert(schema.storedFiles).values({
        name: (m.name || `whatsapp-${Date.now()}.${ext}`).slice(0, 200), mime, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
      }).returning({ id: schema.storedFiles.id });
      await db.update(schema.waMessages).set({ mediaFileId: f.id, mediaMime: mime }).where(eq(schema.waMessages.id, m.id));
    } catch (e) {
      await db.update(schema.waMessages).set({ error: e instanceof WaError ? e.code : "media" }).where(eq(schema.waMessages.id, m.id)).catch(() => {});
    }
  }
}

// ───────────────────────── Ausgehend ─────────────────────────

async function chatOf(chatId: string) {
  const chat = await db.query.waChats.findFirst({ where: eq(schema.waChats.id, chatId) });
  if (!chat) throw new WaError("notFound");
  return chat;
}

async function storeOut(chatId: string, wamid: string, o: { type: string; body: string; mediaFileId?: string | null; mediaMime?: string; mediaName?: string; userId?: string }) {
  const now = new Date();
  const [m] = await db.insert(schema.waMessages).values({
    chatId, waMessageId: wamid || null, direction: "out", type: o.type, body: o.body, mediaFileId: o.mediaFileId ?? null, mediaMime: o.mediaMime ?? "",
    mediaName: o.mediaName ?? "", status: "pending", sentBy: o.userId ?? null, at: now,
  }).returning();
  await db.update(schema.waChats).set({ lastMessageAt: now, lastText: preview(o.type, o.body) }).where(eq(schema.waChats.id, chatId));
  return m;
}

/** Freier Text – nur im 24-Stunden-Fenster */
export async function sendWaText(chatId: string, text: string, userId?: string) {
  const body = text.trim().slice(0, 4096);
  if (!body) throw new WaError("invalid", "empty");
  const s = await active();
  const chat = await chatOf(chatId);
  if (!windowOpen(chat.lastInboundAt)) throw new WaError("window");
  const r = await graph<{ messages?: { id?: string }[] }>(s, "POST", `${s.phoneNumberId}/messages`, {
    messaging_product: "whatsapp", recipient_type: "individual", to: chat.waId, type: "text", text: { preview_url: true, body },
  });
  return storeOut(chatId, String(r.messages?.[0]?.id ?? ""), { type: "text", body, userId });
}

/** Bild (JPEG/PNG ≤ 5 MB) oder Dokument (≤ 16 MB) – im 24-Stunden-Fenster */
export async function sendWaFile(chatId: string, file: { name: string; type: string; data: Buffer }, caption: string, userId?: string) {
  const s = await active();
  const chat = await chatOf(chatId);
  if (!windowOpen(chat.lastInboundAt)) throw new WaError("window");
  const kind = outgoingKind(file.type);
  if (!kind) throw new WaError("fileType");
  if (file.data.length > (kind === "image" ? MAX_IMAGE_BYTES : MAX_DOC_BYTES)) throw new WaError("tooLarge");
  const name = file.name.replace(/[\\/\u0000-\u001f]/g, "").slice(0, 150) || "datei";
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.type);
  form.set("file", new Blob([new Uint8Array(file.data)], { type: file.type }), name);
  const up = await graph<{ id?: string }>(s, "POST", `${s.phoneNumberId}/media`, form);
  if (!up.id) throw new WaError("rejected", "upload");
  const cap = caption.trim().slice(0, 1024);
  const r = await graph<{ messages?: { id?: string }[] }>(s, "POST", `${s.phoneNumberId}/messages`, {
    messaging_product: "whatsapp", recipient_type: "individual", to: chat.waId, type: kind,
    [kind]: kind === "image" ? { id: up.id, ...(cap ? { caption: cap } : {}) } : { id: up.id, filename: name, ...(cap ? { caption: cap } : {}) },
  });
  const [f] = await db.insert(schema.storedFiles).values({
    name, mime: file.type, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), data: file.data,
  }).returning({ id: schema.storedFiles.id });
  return storeOut(chatId, String(r.messages?.[0]?.id ?? ""), { type: kind, body: cap, mediaFileId: f.id, mediaMime: file.type, mediaName: name, userId });
}

export type WaTemplate = { name: string; language: string; category: string; body: string; params: number };
type TplCache = { at: number; list: WaTemplate[] };
const g = globalThis as unknown as { __ssWaTpl?: TplCache; __ssWaUnread?: { at: number; value: number } };

/** Genehmigte Vorlagen (für Nachrichten außerhalb des 24-Stunden-Fensters) – 10 min zwischengespeichert */
export async function listTemplates(force = false): Promise<WaTemplate[]> {
  const s = await active();
  if (!s.wabaId) return [];
  if (!force && g.__ssWaTpl && Date.now() - g.__ssWaTpl.at < 600_000) return g.__ssWaTpl.list;
  const r = await graph<{ data?: { name?: string; language?: string; status?: string; category?: string; components?: { type?: string; text?: string }[] }[] }>(
    s, "GET", `${s.wabaId}/message_templates?fields=name,language,status,category,components&limit=200`);
  const list = (r.data ?? []).filter((t) => t.status === "APPROVED" && t.name).map((t) => {
    const body = (t.components ?? []).find((c) => c.type === "BODY")?.text ?? "";
    const n = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
    return { name: String(t.name), language: String(t.language ?? "de"), category: String(t.category ?? ""), body, params: n.length ? Math.max(...n) : 0 };
  });
  g.__ssWaTpl = { at: Date.now(), list };
  return list;
}

/** Vorlage senden (auch ohne offenes Fenster, z. B. neuer Chat) – kostet bei Meta je nach Kategorie */
export async function sendWaTemplate(chatId: string, t: { name: string; language: string; params: string[] }, userId?: string) {
  const s = await active();
  const chat = await chatOf(chatId);
  const tpl = (await listTemplates()).find((x) => x.name === t.name && x.language === t.language);
  if (!tpl) throw new WaError("template", "unknown");
  const params = t.params.slice(0, tpl.params).map((p) => p.trim().slice(0, 500));
  if (params.length < tpl.params || params.some((p) => !p)) throw new WaError("invalid", "params");
  const r = await graph<{ messages?: { id?: string }[] }>(s, "POST", `${s.phoneNumberId}/messages`, {
    messaging_product: "whatsapp", recipient_type: "individual", to: chat.waId, type: "template",
    template: { name: tpl.name, language: { code: tpl.language }, ...(params.length ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] } : {}) },
  });
  const body = tpl.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, i) => params[Number(i) - 1] ?? "");
  return storeOut(chatId, String(r.messages?.[0]?.id ?? ""), { type: "template", body: body || tpl.name, userId });
}

/** Chat öffnen = gelesen (bei Meta: blaue Haken für die letzte Kundennachricht) */
export async function markChatRead(chatId: string) {
  const chat = await chatOf(chatId);
  if (!chat.unread) return;
  await db.update(schema.waChats).set({ unread: 0 }).where(eq(schema.waChats.id, chatId));
  forgetUnread();
  const last = await db.query.waMessages.findFirst({
    where: and(eq(schema.waMessages.chatId, chatId), eq(schema.waMessages.direction, "in")), orderBy: [desc(schema.waMessages.at), desc(schema.waMessages.seq)], columns: { waMessageId: true },
  });
  if (!last?.waMessageId) return;
  try {
    const s = await active();
    await graph(s, "POST", `${s.phoneNumberId}/messages`, { messaging_product: "whatsapp", status: "read", message_id: last.waMessageId });
  } catch { /* nur Lesebestätigung */ }
}

/** Neuer Chat mit einer Nummer (oder vorhandenen öffnen); Kunde mit derselben Nummer wird verknüpft */
export async function openChat(phone: string, customerId?: string | null): Promise<string> {
  const waId = normalizePhone(phone);
  if (!waId) throw new WaError("invalid", "phone");
  await db.execute(sql`insert into wa_chats (id, wa_id) values (${crypto.randomUUID()}, ${waId}) on conflict (wa_id) do nothing`);
  const chat = (await db.query.waChats.findFirst({ where: eq(schema.waChats.waId, waId) }))!;
  if (!chat.customerId) {
    const cust = customerId || (await customerFor(waId));
    if (cust) await db.update(schema.waChats).set({ customerId: cust }).where(eq(schema.waChats.id, chat.id));
  }
  return chat.id;
}

export async function linkChatCustomer(chatId: string, customerId: string | null, userId?: string) {
  const chat = await chatOf(chatId);
  if (customerId && !(await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId), columns: { id: true } }))) throw new WaError("notFound", "customer");
  await db.update(schema.waChats).set({ customerId }).where(eq(schema.waChats.id, chatId));
  await db.insert(schema.auditLog).values({ entity: "wa_chat", entityId: chatId, action: "link", before: { customerId: chat.customerId }, after: { customerId }, userId: userId ?? null });
}

// ───────────────────────── Anzeigen ─────────────────────────

export async function listChats(q = "") {
  const term = q.trim().slice(0, 60);
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const digits = term.replace(/\D/g, "");
  const rows = await db.select({
    id: schema.waChats.id, waId: schema.waChats.waId, name: schema.waChats.name, unread: schema.waChats.unread, lastText: schema.waChats.lastText,
    lastMessageAt: schema.waChats.lastMessageAt, lastInboundAt: schema.waChats.lastInboundAt, customerId: schema.waChats.customerId, customerName: schema.customers.name,
  }).from(schema.waChats).leftJoin(schema.customers, eq(schema.customers.id, schema.waChats.customerId))
    .where(term ? sql`(${schema.waChats.name} ilike ${like} or ${schema.customers.name} ilike ${like}${digits.length >= 3 ? sql` or ${schema.waChats.waId} like ${`%${digits}%`}` : sql``})` : undefined)
    .orderBy(sql`${schema.waChats.lastMessageAt} desc nulls last`, desc(schema.waChats.createdAt)).limit(300);
  return rows.map((r) => ({ ...r, phone: formatPhone(r.waId) }));
}

export async function chatThread(chatId: string, afterAt?: Date) {
  const chat = await db.query.waChats.findFirst({ where: eq(schema.waChats.id, chatId), with: { customer: { columns: { id: true, name: true, number: true } } } });
  if (!chat) return null;
  const msgs = await db.select().from(schema.waMessages)
    .where(and(eq(schema.waMessages.chatId, chatId), afterAt ? gt(schema.waMessages.at, afterAt) : undefined))
    .orderBy(desc(schema.waMessages.at), desc(schema.waMessages.seq)).limit(300);
  return { chat: { ...chat, phone: formatPhone(chat.waId), windowOpen: windowOpen(chat.lastInboundAt) }, messages: msgs.reverse() };
}

function forgetUnread() { if (g.__ssWaUnread) g.__ssWaUnread.at = 0; }
/** Summe ungelesener Chats (Zahl im Menü) – aus der Datenbank, 10 s zwischengespeichert */
export async function waUnread(): Promise<number> {
  if (g.__ssWaUnread && Date.now() - g.__ssWaUnread.at < 10_000) return g.__ssWaUnread.value;
  const r = await db.execute<{ n: number }>(sql`select coalesce(sum(unread), 0)::int as n from wa_chats`);
  const value = Number(r.rows[0]?.n ?? 0);
  g.__ssWaUnread = { at: Date.now(), value };
  return value;
}
