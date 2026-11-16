/**
 * E-Mail-Postfach im System (Wunsch Inhaber 16.11.2026: Postfach info@starstyle-shop.de in der App) – reine Regeln,
 * ohne Netz und Datenbank, getestet in tests/mail.test.ts. Abruf/Versand: src/lib/mailbox.ts (IMAP/SMTP).
 * IMAP lässt alle Nachrichten auf dem Server: Webmail und System zeigen dasselbe (gelesen/ungelesen, „Gesendet“).
 */

export type MailSettings = {
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number;
  user: string; password: string; // Passwort (App-Passwort) verschlüsselt (crypto.ts)
  fromName: string; signature: string;
  /** Signatur mit Logo (HTML, z. B. aus dem Hostinger-Webmail kopiert) – beim Speichern bereinigt (sanitizeSignatureHtml) */
  signatureHtml: string;
  /** Text der E-Mail zu Rechnung/Angebot (Wunsch Inhaber 16.11.2026: selbst ändern); leer = Standardtext */
  invoiceText: string; offerText: string;
};
export const SIGNATURE_HTML_MAX = 20_000;
export const DOC_TEXT_MAX = 3000;

/** Standardtexte der Beleg-E-Mails – Platzhalter {doc} {number} {due} {valid} {sender} */
export const DEFAULT_DOC_TEXTS = {
  invoice: "Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere {doc} {number}. {due}\n\nMit freundlichen Grüßen\n{sender}",
  offer: "Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unser Angebot {number}. Es ist gültig bis {valid}.\n\nMit freundlichen Grüßen\n{sender}",
} as const;
export const DOC_TEXT_KEYS = { invoice: ["doc", "number", "due", "sender"], offer: ["number", "valid", "sender"] } as const;

/** Platzhalter füllen (nur bekannte), Leerzeichen am Zeilenende weg, höchstens 2 Leerzeilen hintereinander */
export function fillDocText(kind: "invoice" | "offer", template: string, vars: Record<string, string>): string {
  const tpl = template.trim() ? template : DEFAULT_DOC_TEXTS[kind];
  const keys: readonly string[] = DOC_TEXT_KEYS[kind];
  return tpl
    .replace(/\{(\w+)\}/g, (m, k: string) => (keys.includes(k) ? (vars[k] ?? "") : m))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hostinger (hPanel → E-Mails → Connect apps & devices, 16.11.2026): IMAP 993 und SMTP 465, beide SSL/TLS */
export const MAIL_DEFAULTS = { imapHost: "imap.hostinger.com", imapPort: 993, smtpHost: "smtp.hostinger.com", smtpPort: 465 } as const;

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const validHost = (h: string) => HOST.test(h.trim().toLowerCase());
export const validPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;
export const validEmail = (e: string) => e.length <= 254 && EMAIL.test(e);

/** Gespeicherte Einstellungen lesen – wirft nie, fehlende Werte = Hostinger-Standard */
export function parseMailSettings(raw: unknown, fallbackUser = ""): MailSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (k: string, max = 200) => (typeof o[k] === "string" ? (o[k] as string).trim().slice(0, max) : "");
  const num = (k: string, d: number) => (typeof o[k] === "number" && validPort(o[k] as number) ? (o[k] as number) : d);
  const host = (k: string, d: string) => { const h = str(k).toLowerCase(); return validHost(h) ? h : d; };
  return {
    imapHost: host("imapHost", MAIL_DEFAULTS.imapHost), imapPort: num("imapPort", MAIL_DEFAULTS.imapPort),
    smtpHost: host("smtpHost", MAIL_DEFAULTS.smtpHost), smtpPort: num("smtpPort", MAIL_DEFAULTS.smtpPort),
    user: str("user").toLowerCase() || fallbackUser.trim().toLowerCase(), password: typeof o.password === "string" ? o.password : "",
    fromName: str("fromName", 80), signature: typeof o.signature === "string" ? o.signature.slice(0, 2000) : "",
    signatureHtml: typeof o.signatureHtml === "string" ? o.signatureHtml.slice(0, SIGNATURE_HTML_MAX) : "",
    invoiceText: typeof o.invoiceText === "string" ? o.invoiceText.slice(0, DOC_TEXT_MAX) : "",
    offerText: typeof o.offerText === "string" ? o.offerText.slice(0, DOC_TEXT_MAX) : "",
  };
}

/** eingerichtet = Benutzer + Passwort gespeichert */
export const mailboxReady = (s: MailSettings) => Boolean(s.user && s.password && validHost(s.imapHost) && validHost(s.smtpHost));

/** „a@x.de, B <b@y.de>; c@z.de“ → Adressen (klein, ohne Doppelte); ungültige werden gemeldet */
export function parseAddressList(input: string, max = 20): { ok: string[]; bad: string[] } {
  const ok: string[] = []; const bad: string[] = [];
  for (const part of input.split(/[,;\n]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/<([^<>]+)>\s*$/);
    const addr = (m ? m[1] : p).trim().toLowerCase();
    if (validEmail(addr)) { if (!ok.includes(addr)) ok.push(addr); } else bad.push(p.slice(0, 80));
  }
  if (ok.length > max) { bad.push(...ok.splice(max)); }
  return { ok, bad };
}

const RE_PREFIX = /^\s*((re|aw|antw|wg|fw|fwd|tr)\s*(\[\d+\])?\s*:\s*)+/i;
export const replySubject = (s: string) => `Re: ${s.replace(RE_PREFIX, "").trim() || "(ohne Betreff)"}`.slice(0, 250);
export const forwardSubject = (s: string) => `Fwd: ${s.replace(RE_PREFIX, "").trim() || "(ohne Betreff)"}`.slice(0, 250);

/** Antwort: Originaltext mit „> “ zitiert, darüber „Am … schrieb …:“ */
export function quoteText(text: string, from: string, date: string): string {
  const body = text.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd().split("\n").slice(0, 400).map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`)).join("\n");
  return `\n\n\nAm ${date} schrieb ${from}:\n${body}\n`;
}

/** Weiterleiten: Kopf der Originalnachricht + Text */
export function forwardText(o: { from: string; to: string; date: string; subject: string; text: string }): string {
  return `\n\n\n---------- Weitergeleitete Nachricht ----------\nVon: ${o.from}\nDatum: ${o.date}\nBetreff: ${o.subject}\nAn: ${o.to}\n\n${o.text.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

/** Dateiname für Download-Kopfzeilen: keine Pfade, keine Steuerzeichen */
export function safeFilename(name: string | undefined | null, fallback = "anhang"): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, 150);
  return clean || fallback;
}

/** Nur echte Bilder dürfen im Browser angezeigt werden (kein SVG/HTML – sonst Skripte auf unserer Seite); alles andere = Download */
export const inlineSafe = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);

export type FolderRole = "inbox" | "sent" | "drafts" | "junk" | "trash" | "archive" | "other";
/** Ordner erkennen (IMAP special-use zuerst, dann übliche Namen) – für Symbol, Reihenfolge und Übersetzung */
export function folderRole(path: string, specialUse?: string | null): FolderRole {
  const su = (specialUse ?? "").toLowerCase();
  if (path.toUpperCase() === "INBOX") return "inbox";
  if (su === "\\sent") return "sent";
  if (su === "\\drafts") return "drafts";
  if (su === "\\junk") return "junk";
  if (su === "\\trash") return "trash";
  if (su === "\\archive") return "archive";
  const n = (path.split(/[./]/).pop() ?? path).toLowerCase();
  if (["sent", "sent items", "sent messages", "gesendet", "gesendete objekte", "gesendete elemente"].includes(n)) return "sent";
  if (["drafts", "draft", "entwürfe", "entwurf"].includes(n)) return "drafts";
  if (["junk", "spam", "junk e-mail"].includes(n)) return "junk";
  if (["trash", "deleted", "deleted items", "deleted messages", "papierkorb", "gelöschte elemente", "bin"].includes(n)) return "trash";
  if (["archive", "archiv"].includes(n)) return "archive";
  return "other";
}
export const ROLE_ORDER: Record<FolderRole, number> = { inbox: 0, sent: 1, drafts: 2, archive: 3, junk: 4, trash: 5, other: 6 };

/** Seiten in der Liste: neueste zuerst, `size` je Seite → Sequenznummern (1 = älteste) */
export function pageRange(exists: number, page: number, size = 50): { from: number; to: number } | null {
  if (exists <= 0) return null;
  const p = Math.max(1, Math.floor(page));
  const to = exists - (p - 1) * size;
  if (to < 1) return null;
  return { from: Math.max(1, to - size + 1), to };
}

/** Größe für Menschen: 1,2 MB / 340 KB */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ───────────────────────── Signatur mit Logo (HTML) ─────────────────────────

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Stelle für die Signatur: vor dem zitierten Original (Antworten/Weiterleiten aus quoteText/forwardText), sonst am Ende */
export function signatureSplit(text: string): number {
  const m = /\n\n\nAm [^\n]* schrieb [^\n]*:\n|\n\n\n---------- Weitergeleitete Nachricht ----------\n/.exec(text);
  return m ? m.index : text.length;
}

/** Text der Nachricht → einfaches HTML (Zeilen bleiben, „> “-Zeilen als graues Zitat) */
export function textToHtml(text: string): string {
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (!quote.length) return;
    out.push(`<blockquote style="margin:0 0 0 4px;border-left:2px solid #c7cbd3;padding-left:8px;color:#5B6475">${quote.join("<br>")}</blockquote>`);
    quote = [];
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(">")) { quote.push(escHtml(line.replace(/^> ?/, ""))); continue; }
    flush();
    out.push(escHtml(line) + "<br>");
  }
  flush();
  return out.join("");
}

/**
 * Text + Signatur → Text- und HTML-Teil der E-Mail. Die Signatur steht unter dem eigenen Text, vor dem zitierten Original.
 * sigHtml ist schon bereinigt (sanitizeSignatureHtml); sigText ist die Textfassung für Programme ohne HTML.
 */
export function buildMailBodies(text: string, sig: { html: string; text: string } | null): { text: string; html?: string } {
  if (!sig || !sig.html.trim()) return { text };
  const t = text.replace(/\r\n/g, "\n");
  const i = signatureSplit(t);
  const head = t.slice(0, i).replace(/\s+$/, "");
  const tail = t.slice(i);
  const plain = `${head}\n\n-- \n${sig.text.trim()}\n${tail}`;
  const html = `<div dir="auto" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0B1222">`
    + `${head ? `${textToHtml(head)}<br>` : ""}${sig.html}${tail.trim() ? `<br>${textToHtml(tail.replace(/^\n+/, ""))}` : ""}</div>`;
  return { text: plain, html };
}
