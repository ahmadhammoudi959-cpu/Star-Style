/**
 * WhatsApp Web im System (Wunsch Inhaber 16.11.2026: „الواتساب يشتغل جوه الابلكيشن … يمسح الكيو ار كود جوه الابلكيشن“).
 * Rein, läuft auch im Browser (keine Node-Module) – getestet in tests/wa-web.test.ts.
 *
 * WhatsApp Web verbietet das Einbetten in fremde Seiten (X-Frame-Options/CSP). Die Chrome-Erweiterung
 * „Star Style – WhatsApp im System“ (src/lib/wa-extension.ts) hebt das NUR für Rahmen auf unserer eigenen Adresse auf.
 * Die Sitzung liegt im Chrome des Laptops (wie normales WhatsApp Web) – nichts läuft über unseren Server.
 */
export const WA_WEB_ORIGIN = "https://web.whatsapp.com";
/** Fenster-Ereignis mit der Zahl ungelesener Chats (detail = Zahl), für die Zahl im Menü */
export const WA_UNREAD_EVENT = "ss:wa-unread";

/** Telefonnummer → Ziffern mit Ländervorwahl ohne „+“ (0178… = Deutschland); leer, wenn unbrauchbar */
export function waDigits(input: string | null | undefined, country = "49"): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1).replace(/\D/g, "");
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = country + d.slice(1);
  d = d.replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/** Adresse im Rahmen: ohne Nummer die Chatliste, mit Nummer gleich der Chat mit dieser Person */
export function waWebUrl(phone?: string | null): string {
  const d = waDigits(phone);
  return d ? `${WA_WEB_ORIGIN}/send?phone=${d}` : `${WA_WEB_ORIGIN}/`;
}

/** Handy: Chat in der WhatsApp-(Business-)App öffnen */
export function waMeUrl(phone?: string | null): string {
  const d = waDigits(phone);
  return d ? `https://wa.me/${d}` : "https://wa.me/";
}

/** „(3) WhatsApp“ → 3 (WhatsApp Web zeigt die ungelesenen Chats im Fenstertitel) */
export function unreadFromTitle(title: string | null | undefined): number {
  const m = /^\s*\((\d{1,4})\)/.exec(title ?? "");
  return m ? Number(m[1]) : 0;
}

/** Nachricht der Erweiterung aus dem WhatsApp-Rahmen prüfen: { ssWaUnread: n } */
export function unreadFromMessage(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const n = (data as { ssWaUnread?: unknown }).ssWaUnread;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100000 ? n : null;
}

/** Antwort der Erweiterung auf unserer Seite: { ssWaExt: "1.0.0" } → Version */
export function extVersionFromMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const v = (data as { ssWaExt?: unknown }).ssWaExt;
  return typeof v === "string" && /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
}

/** Was WhatsApp im Rahmen gerade zeigt (Erweiterung ab 1.1.0): Anmeldeseite mit QR-Code oder die Chats */
export type WaState = "qr" | "app";

/** Nachricht der Erweiterung aus dem WhatsApp-Rahmen: { ssWaUnread: n, ssWaState: "qr" | "app" } → Zustand */
export function stateFromMessage(data: unknown): WaState | null {
  if (!data || typeof data !== "object") return null;
  const s = (data as { ssWaState?: unknown }).ssWaState;
  return s === "qr" || s === "app" ? s : null;
}

/** Version der Erweiterung mindestens `min`? ("1.0.10" ≥ "1.0.2") */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/**
 * Neu verknüpfen nötig, obwohl WhatsApp auf diesem Computer schon verknüpft war?
 * Nur wenn der Rahmen gleich mit der Anmeldeseite startet (nicht, wenn sich jemand in WhatsApp selbst abmeldet)
 * und noch keine Chats zu sehen sind.
 */
export function needsRelink(first: WaState | null, now: WaState | null, linkedAt: string | null): boolean {
  return first === "qr" && now === "qr" && !!linkedAt;
}
