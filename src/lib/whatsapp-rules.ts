/**
 * WhatsApp im System (Wunsch Inhaber 16.11.2026) – reine Regeln ohne Netz/Datenbank, getestet in tests/whatsapp.test.ts.
 * Anbindung: Meta WhatsApp Cloud API (Graph API). Senden/Empfangen: src/lib/whatsapp.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type WaSettings = {
  phoneNumberId: string; wabaId: string; displayPhone: string; verifiedName: string;
  accessToken: string; appSecret: string; // verschlüsselt (crypto.ts)
  verifyToken: string; apiVersion: string;
};

export const WA_DEFAULT_VERSION = "v24.0";
const ID = /^\d{5,30}$/;
export const validMetaId = (s: string) => ID.test(s);
export const validVersion = (s: string) => /^v\d{2}\.0$/.test(s);

export function parseWaSettings(raw: unknown): WaSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (k: string, max = 500) => (typeof o[k] === "string" ? (o[k] as string).trim().slice(0, max) : "");
  const v = str("apiVersion", 10);
  return {
    phoneNumberId: validMetaId(str("phoneNumberId")) ? str("phoneNumberId") : "", wabaId: validMetaId(str("wabaId")) ? str("wabaId") : "",
    displayPhone: str("displayPhone", 40), verifiedName: str("verifiedName", 120),
    accessToken: typeof o.accessToken === "string" ? o.accessToken : "", appSecret: typeof o.appSecret === "string" ? o.appSecret : "",
    verifyToken: str("verifyToken", 100), apiVersion: validVersion(v) ? v : WA_DEFAULT_VERSION,
  };
}

/** eingerichtet = Nummer-ID + Token + App-Geheimnis (ohne Geheimnis keine Prüfung eingehender Nachrichten) */
export const waReady = (s: WaSettings) => Boolean(s.phoneNumberId && s.accessToken && s.appSecret && s.verifyToken);

/**
 * Telefonnummer → WhatsApp-ID (international, nur Ziffern, ohne +): „+49 178 557 17 25“, „0049…“, „0178 …“ (Deutschland)
 * → „491785571725“. Leer/ungültig → "".
 */
export function normalizePhone(input: string, country = "49"): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1).replace(/\D/g, "");
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = country + d.slice(1);
  d = d.replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/** Anzeige: „+49 178 5571725“ (grob gruppiert, nur zum Lesen) */
export function formatPhone(waId: string): string {
  if (!waId) return "";
  const cc = waId.startsWith("49") ? 2 : waId.startsWith("1") ? 1 : waId.length > 11 ? 3 : 2;
  const rest = waId.slice(cc);
  return `+${waId.slice(0, cc)} ${rest.slice(0, 3)} ${rest.slice(3)}`.trim();
}

/** Freie Nachrichten nur innerhalb von 24 Stunden nach der letzten Nachricht des Kunden (sonst nur genehmigte Vorlagen) */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export function windowOpen(lastInboundAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!lastInboundAt) return false;
  return now - new Date(lastInboundAt).getTime() < WINDOW_MS;
}
export function windowLeftMs(lastInboundAt: Date | string | null | undefined, now = Date.now()): number {
  if (!lastInboundAt) return 0;
  return Math.max(0, WINDOW_MS - (now - new Date(lastInboundAt).getTime()));
}

/** Webhook-Signatur: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(App-Geheimnis, roher Body) – zeitkonstant verglichen */
export function validSignature(rawBody: Buffer | string, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(header.slice(7), "hex"); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

export type WaInbound = {
  waId: string; name: string; wamid: string; at: Date; type: string; body: string;
  mediaId: string | null; mediaMime: string; mediaName: string; replyTo: string | null;
};
export type WaStatus = { wamid: string; status: string; at: Date; error: string };

const MEDIA = ["image", "document", "audio", "video", "sticker"] as const;

/** Webhook-Inhalt (Meta „whatsapp_business_account“) → eingehende Nachrichten + Status, nur für unsere Nummer */
export function parseWebhook(payload: unknown, phoneNumberId: string): { messages: WaInbound[]; statuses: WaStatus[] } {
  const out = { messages: [] as WaInbound[], statuses: [] as WaStatus[] };
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
  if (!p || p.object !== "whatsapp_business_account" || !Array.isArray(p.entry)) return out;
  for (const e of p.entry) for (const ch of e.changes ?? []) {
    const v = ch.value as {
      metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[];
      messages?: Record<string, unknown>[]; statuses?: Record<string, unknown>[];
    } | undefined;
    if (!v || ch.field !== "messages" || v.metadata?.phone_number_id !== phoneNumberId) continue;
    const names = new Map((v.contacts ?? []).map((c) => [String(c.wa_id ?? ""), String(c.profile?.name ?? "").slice(0, 120)]));
    for (const m of v.messages ?? []) {
      const type = String(m.type ?? "unsupported");
      const from = String(m.from ?? "").replace(/\D/g, "");
      const wamid = String(m.id ?? "");
      if (!from || !wamid) continue;
      const at = new Date(Number(m.timestamp ?? 0) * 1000 || Date.now());
      let body = "", mediaId: string | null = null, mediaMime = "", mediaName = "";
      const part = (m[type] ?? {}) as Record<string, unknown>;
      if (type === "text") body = String((m.text as { body?: string })?.body ?? "");
      else if ((MEDIA as readonly string[]).includes(type)) {
        mediaId = typeof part.id === "string" ? part.id : null;
        mediaMime = String(part.mime_type ?? "");
        mediaName = String(part.filename ?? "");
        body = String(part.caption ?? "");
      } else if (type === "location") {
        const l = part as { latitude?: number; longitude?: number; name?: string; address?: string };
        body = [l.name, l.address, l.latitude != null && l.longitude != null ? `https://maps.google.com/?q=${l.latitude},${l.longitude}` : ""].filter(Boolean).join(" · ");
      } else if (type === "reaction") body = String((part as { emoji?: string }).emoji ?? "");
      else if (type === "button") body = String((m.button as { text?: string })?.text ?? "");
      else if (type === "interactive") {
        const i = part as { button_reply?: { title?: string }; list_reply?: { title?: string } };
        body = String(i.button_reply?.title ?? i.list_reply?.title ?? "");
      } else if (type === "contacts") body = ((m.contacts as { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[]) ?? []).map((c) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(" ")).join(", ");
      const ctx = m.context as { id?: string } | undefined;
      out.messages.push({
        waId: from, name: names.get(from) ?? "", wamid, at, type, body: body.slice(0, 10_000), mediaId, mediaMime: mediaMime.slice(0, 100), mediaName: mediaName.slice(0, 200),
        replyTo: type === "reaction" ? String((part as { message_id?: string }).message_id ?? "") || null : ctx?.id ?? null,
      });
    }
    for (const s of v.statuses ?? []) {
      const errs = (s.errors as { code?: number; title?: string; message?: string; error_data?: { details?: string } }[] | undefined) ?? [];
      out.statuses.push({
        wamid: String(s.id ?? ""), status: String(s.status ?? ""), at: new Date(Number(s.timestamp ?? 0) * 1000 || Date.now()),
        error: errs.map((x) => [x.code, x.title, x.error_data?.details ?? x.message].filter(Boolean).join(" ")).join("; ").slice(0, 500),
      });
    }
  }
  return out;
}

/** Status nur vorwärts: sent → delivered → read (spätere Meldungen in anderer Reihenfolge überschreiben nicht) */
const RANK: Record<string, number> = { "": 0, pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
export const statusAfter = (cur: string, next: string) => ((RANK[next] ?? 0) > (RANK[cur] ?? 0) ? next : cur);

/** Graph-Fehler → verständlicher Code */
export function graphErrorCode(err: { code?: number; error_subcode?: number } | undefined, httpStatus: number): string {
  const c = err?.code;
  if (c === 190 || httpStatus === 401) return "auth";
  if (c === 131047) return "window"; // mehr als 24 Stunden seit der letzten Kundennachricht
  if (c === 131026) return "undeliverable";
  if (c === 131030) return "notAllowed";
  if (c === 132000 || c === 132001 || c === 132005 || c === 132007 || c === 132012) return "template";
  if (c === 130429 || c === 131048 || c === 131056 || c === 80007 || httpStatus === 429) return "rate";
  if (c === 100 || httpStatus === 400) return "invalid";
  return httpStatus >= 500 ? "network" : "rejected";
}

/** Vorlagen: Anzahl Platzhalter {{1}} … im Text */
export function templateParams(text: string): number {
  const nums = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** Medien, die WhatsApp annimmt (ausgehend), und Größen (Cloud API) */
export function outgoingKind(mime: string): "image" | "document" | null {
  if (/^image\/(jpeg|png)$/i.test(mime)) return "image";
  if (mime) return "document";
  return null;
}
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOC_BYTES = 16 * 1024 * 1024; // eigene Grenze (Meta: 100 MB) – so passt alles in die Datenbank/Sicherung
