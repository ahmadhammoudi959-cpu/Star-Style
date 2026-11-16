import "server-only";
/**
 * Postfach info@ im System (Wunsch Inhaber 16.11.2026: „صندوق الإيميل جوه التطبيق … يشوف هنا وهنا عادي“):
 * IMAP lesen (alles bleibt auf dem Server – Webmail und System sehen dasselbe), SMTP senden + Kopie in „Gesendet“.
 * Zugang: Hostinger App-Passwort (das Postfach hat Zwei-Schritt), verschlüsselt in company_settings.mail.
 * Nie endgültig löschen – „Löschen“ verschiebt in den Papierkorb des Postfachs. Reine Regeln: ./mail-rules.ts.
 */
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type AddressObject, type Attachment } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import sanitizeHtml from "sanitize-html";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "./crypto";
import {
  buildMailBodies, folderRole, mailboxReady, pageRange, parseMailSettings, ROLE_ORDER, SIGNATURE_HTML_MAX, validEmail, validHost, validPort,
  type FolderRole, type MailSettings,
} from "./mail-rules";

export class MailboxError extends Error {
  /** notConfigured | auth | network | notFound | tooLarge | invalid | send */
  constructor(public code: string, message = code) { super(message); }
}

const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

export async function loadMailSettings(): Promise<MailSettings> {
  const row = await db.query.companySettings.findFirst({ columns: { mail: true, email: true } });
  return parseMailSettings(row?.mail, row?.email ?? "");
}

async function active(): Promise<MailSettings> {
  const s = await loadMailSettings();
  if (!mailboxReady(s)) throw new MailboxError("notConfigured");
  try { return { ...s, password: decrypt(s.password) }; } catch { throw new MailboxError("notConfigured"); }
}

export const mailboxConfigured = async () => { try { return mailboxReady(await loadMailSettings()); } catch { return false; } };

export type MailSettingsInput = {
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; user: string; password: string;
  fromName: string; signature: string; signatureHtml?: string; disconnect?: boolean;
};
export type MailSettingsProblem = "imapHost" | "smtpHost" | "port" | "user" | "password";

/** Speichern; leeres Passwort = altes behalten; disconnect = Zugang entfernen (Postfach bleibt, nur das System liest nicht mehr) */
export async function saveMailSettings(input: MailSettingsInput, userId?: string): Promise<{ ok: true } | { problem: MailSettingsProblem }> {
  const imapHost = input.imapHost.trim().toLowerCase(), smtpHost = input.smtpHost.trim().toLowerCase();
  const user = input.user.trim().toLowerCase();
  if (!input.disconnect) {
    if (!validHost(imapHost)) return { problem: "imapHost" };
    if (!validHost(smtpHost)) return { problem: "smtpHost" };
    if (!validPort(input.imapPort) || !validPort(input.smtpPort)) return { problem: "port" };
    if (!validEmail(user)) return { problem: "user" };
  }
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; mail: unknown; email: string }>(sql`select id, mail, email from company_settings order by id limit 1 for update`);
    const row = rows.rows[0];
    const before = parseMailSettings(row?.mail, row?.email ?? "");
    const password = input.disconnect ? "" : input.password ? encrypt(input.password.slice(0, 300)) : before.user === user ? before.password : "";
    if (!input.disconnect && !password) return { problem: "password" as const };
    const signatureHtml = input.signatureHtml === undefined ? before.signatureHtml : sanitizeSignatureHtml(input.signatureHtml);
    const next = input.disconnect ? { fromName: before.fromName, signature: before.signature, signatureHtml: before.signatureHtml } : {
      imapHost, imapPort: input.imapPort, smtpHost, smtpPort: input.smtpPort, user, password,
      fromName: input.fromName.trim().slice(0, 80), signature: input.signature.slice(0, 2000), signatureHtml,
    };
    if (row) await tx.update(schema.companySettings).set({ mail: next }).where(eq(schema.companySettings.id, row.id));
    else await tx.insert(schema.companySettings).values({ id: "company", mail: next });
    const show = (s: Partial<MailSettings>) => ({ imapHost: s.imapHost, imapPort: s.imapPort, smtpHost: s.smtpHost, smtpPort: s.smtpPort, user: s.user, fromName: s.fromName, password: s.password ? "gesetzt" : "" });
    await tx.insert(schema.auditLog).values({
      entity: "settings", entityId: "mail", action: input.disconnect ? "disconnect" : "update", userId: userId ?? null,
      before: show(before), after: { ...show(next as Partial<MailSettings>), passwordChanged: Boolean(input.password), signatureHtmlChanged: signatureHtml !== before.signatureHtml }, // nie das Passwort ins Protokoll
    });
    forgetUnread();
    return { ok: true as const };
  });
}

function classify(e: unknown): MailboxError {
  if (e instanceof MailboxError) return e;
  const err = e as { authenticationFailed?: boolean; code?: string; responseCode?: number; message?: string; responseText?: string };
  const msg = `${err?.message ?? ""} ${err?.responseText ?? ""}`.trim();
  if (err?.authenticationFailed || err?.code === "EAUTH" || err?.responseCode === 535 || /auth|login failed|credentials|password/i.test(msg)) return new MailboxError("auth", msg.slice(0, 200));
  if (err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT" || err?.code === "ESOCKET" || err?.code === "ECONNECTION" || /timeout|timed out|socket|connect/i.test(msg)) return new MailboxError("network", msg.slice(0, 200));
  return new MailboxError("network", msg.slice(0, 200) || "error");
}

/** Eine IMAP-Verbindung je Vorgang (einfach und robust; Hostinger braucht ~0,5–1 s zum Anmelden) */
async function withImap<T>(fn: (c: ImapFlow) => Promise<T>, settings?: MailSettings): Promise<T> {
  const s = settings ?? await active();
  const c = new ImapFlow({
    host: s.imapHost, port: s.imapPort, secure: s.imapPort === 993, auth: { user: s.user, pass: s.password },
    logger: false, disableAutoIdle: true, socketTimeout: 60_000, greetingTimeout: 15_000, connectionTimeout: 15_000,
    clientInfo: { name: "Star Style", version: "1" },
  } as ConstructorParameters<typeof ImapFlow>[0]);
  c.on("error", () => { /* Verbindung weg – der laufende Aufruf meldet den Fehler selbst */ });
  try { await c.connect(); } catch (e) { throw classify(e); }
  try { return await fn(c); } catch (e) { throw classify(e); } finally {
    try { await c.logout(); } catch { c.close(); }
  }
}

// ───────────────────────── Ordner ─────────────────────────

export type MailFolder = { path: string; name: string; role: FolderRole; unseen: number; total: number };

async function folders(c: ImapFlow): Promise<MailFolder[]> {
  const list = await c.list({ statusQuery: { messages: true, unseen: true } });
  return list
    .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
    .map((f) => ({ path: f.path, name: f.name, role: folderRole(f.path, f.specialUse), unseen: f.status?.unseen ?? 0, total: f.status?.messages ?? 0 }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.path.localeCompare(b.path));
}

export async function listFolders(): Promise<MailFolder[]> {
  return withImap((c) => folders(c));
}

// ───────────────────────── Liste ─────────────────────────

export type MailAddress = { name: string; address: string };
export type MailListItem = {
  uid: number; seen: boolean; flagged: boolean; answered: boolean; from: MailAddress[]; to: MailAddress[];
  subject: string; date: string; size: number; attachment: boolean;
};

const addr = (list?: { name?: string; address?: string }[]): MailAddress[] =>
  (list ?? []).map((a) => ({ name: (a.name ?? "").trim(), address: (a.address ?? "").trim().toLowerCase() })).filter((a) => a.name || a.address);

function hasAttachment(n?: MessageStructureObject): boolean {
  if (!n) return false;
  if (n.childNodes?.length) return n.childNodes.some(hasAttachment);
  if (n.disposition === "attachment") return true;
  const named = Boolean(n.dispositionParameters?.filename || n.parameters?.name);
  return named && !/^text\/(plain|html)$/i.test(n.type) && n.disposition !== "inline";
}

function toItem(m: FetchMessageObject): MailListItem {
  const flags = m.flags ?? new Set<string>();
  const d = m.envelope?.date ?? m.internalDate;
  return {
    uid: m.uid, seen: flags.has("\\Seen"), flagged: flags.has("\\Flagged"), answered: flags.has("\\Answered"),
    from: addr(m.envelope?.from), to: addr(m.envelope?.to), subject: (m.envelope?.subject ?? "").trim(),
    date: d ? new Date(d).toISOString() : "", size: m.size ?? 0, attachment: hasAttachment(m.bodyStructure),
  };
}

export async function listMessages(path: string, o: { page?: number; q?: string; size?: number } = {}) {
  const size = o.size ?? 50, page = Math.max(1, o.page ?? 1), q = (o.q ?? "").trim().slice(0, 100);
  return withImap(async (c) => {
    const all = await folders(c);
    const folder = all.find((f) => f.path === path);
    if (!folder) throw new MailboxError("notFound");
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const query = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true };
      let items: MailListItem[] = [];
      let total = 0;
      if (q) {
        const found = (await c.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true })) || [];
        const uids = [...found].sort((a, b) => b - a);
        total = uids.length;
        const slice = uids.slice((page - 1) * size, page * size);
        if (slice.length) for await (const m of c.fetch(slice.join(","), query, { uid: true })) items.push(toItem(m));
        items.sort((a, b) => b.uid - a.uid);
      } else {
        const exists = c.mailbox ? c.mailbox.exists : 0;
        total = exists;
        const r = pageRange(exists, page, size);
        if (r) for await (const m of c.fetch(`${r.from}:${r.to}`, query)) items.push(toItem(m));
        items = items.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.uid - a.uid);
      }
      return { folders: all, folder, items, total, page, pages: Math.max(1, Math.ceil(total / size)) };
    } finally { lock.release(); }
  });
}

// ───────────────────────── Nachricht ─────────────────────────

export type MailMessage = {
  path: string; uid: number; subject: string; from: MailAddress[]; to: MailAddress[]; cc: MailAddress[]; replyTo: MailAddress[];
  date: string; messageId: string; references: string[]; text: string; html: string | null; blockedImages: number;
  attachments: { index: number; filename: string; contentType: string; size: number }[]; seen: boolean; flagged: boolean; answered: boolean;
};

const parsedAddr = (a?: AddressObject | AddressObject[]): MailAddress[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => addr(x.value.map((v) => ({ name: v.name, address: v.address }))));

/** HTML aus E-Mails: nur Formatierung, keine Skripte/Formulare; Bilder nur eingebettete (cid/data) – fremde Bilder (Zählpixel) blockiert */
/**
 * Signatur mit Logo (HTML aus dem Webmail): nur Tabellen/Text/Links/Bilder, Bilder nur über https, Links http(s)/mailto/tel,
 * keine Skripte, Formulare, Event-Attribute, <style>; Stil-Angaben mit url()/expression/javascript fallen weg.
 */
export function sanitizeSignatureHtml(html: string): string {
  const clean = sanitizeHtml(String(html ?? "").slice(0, SIGNATURE_HTML_MAX * 2), {
    allowedTags: ["table", "tbody", "thead", "tfoot", "tr", "td", "th", "div", "span", "p", "a", "img", "br", "strong", "b", "em", "i", "u", "small", "font", "hr", "center"],
    allowedAttributes: {
      "*": ["style", "dir", "align", "valign", "width", "height", "bgcolor", "title"],
      a: ["href", "target", "rel"], img: ["src", "alt", "width", "height", "border"],
      table: ["cellpadding", "cellspacing", "border", "role"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], font: ["color", "face", "size"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    transformTags: {
      "*": (tagName, attribs) => {
        const style = attribs.style;
        if (style && /url\s*\(|expression|javascript:|@import|behavior/i.test(style)) { const { style: _drop, ...rest } = attribs; void _drop; return { tagName, attribs: rest }; }
        return { tagName, attribs };
      },
    },
  }).trim();
  return clean.length > SIGNATURE_HTML_MAX ? "" : clean;
}

export function sanitizeEmailHtml(html: string, cid: Map<string, string>): { html: string; blocked: number } {
  let blocked = 0;
  const out = sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags, "img", "style", "font", "center", "span", "div", "u", "s", "small", "big", "sub", "sup",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br",
    ],
    allowVulnerableTags: true, // <style> – sicher: abgeschottetes iframe ohne Skripte, mit unserer CSP (keine fremden Quellen)
    allowedAttributes: {
      "*": ["style", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing", "dir", "lang", "title", "colspan", "rowspan", "face", "size", "class"],
      a: ["href", "name", "target", "rel"], img: ["src", "alt", "width", "height", "style"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attribs) => ({ tagName: "a", attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (_tag, attribs) => {
        const src = (attribs.src ?? "").trim();
        if (/^cid:/i.test(src)) {
          const d = cid.get(src.slice(4).replace(/^<|>$/g, "").toLowerCase());
          if (d) return { tagName: "img", attribs: { ...attribs, src: d } };
        } else if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return { tagName: "img", attribs };
        blocked++;
        return { tagName: "span", attribs: {}, text: attribs.alt ? `[${attribs.alt.slice(0, 80)}]` : "" };
      },
    },
  });
  return { html: out, blocked };
}

/** Nur-HTML-E-Mails: lesbarer Text (zum Zitieren beim Antworten und für die Vorschau) */
export function htmlToPlain(html: string): string {
  const marked = html.replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/table|\/blockquote)\b[^>]*>/gi, "\n");
  const text = sanitizeHtml(marked, { allowedTags: [], allowedAttributes: {}, nonTextTags: ["style", "script", "textarea", "option", "noscript", "head", "title"] });
  return text
    .replace(/&nbsp;|\u00a0/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function parseMessage(c: ImapFlow, uid: number) {
  const meta = await c.fetchOne(String(uid), { uid: true, flags: true, size: true }, { uid: true });
  if (!meta) throw new MailboxError("notFound");
  if ((meta.size ?? 0) > MAX_MESSAGE_BYTES) throw new MailboxError("tooLarge");
  const dl = await c.download(String(uid), undefined, { uid: true });
  if (!dl.content) throw new MailboxError("notFound");
  const parsed = await simpleParser(dl.content, { skipImageLinks: true, skipTextLinks: true, skipHtmlToText: false });
  return { meta, parsed };
}

/** Nachricht lesen (öffnen = gelesen, wie im Webmail) */
export async function readMessage(path: string, uid: number, o: { markSeen?: boolean } = {}): Promise<MailMessage> {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(path);
    try {
      const { meta, parsed } = await parseMessage(c, uid);
      if (o.markSeen !== false && !meta.flags?.has("\\Seen")) await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      const atts: Attachment[] = parsed.attachments ?? [];
      const cid = new Map<string, string>();
      for (const a of atts) {
        if (a.cid && /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType) && a.size <= 2 * 1024 * 1024) cid.set(a.cid.replace(/^<|>$/g, "").toLowerCase(), `data:${a.contentType};base64,${a.content.toString("base64")}`);
      }
      const rawHtml = typeof parsed.html === "string" ? parsed.html : "";
      const clean = rawHtml ? sanitizeEmailHtml(rawHtml, cid) : null;
      const usedCids = new Set([...rawHtml.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1].toLowerCase()));
      refreshUnreadSoon();
      return {
        path, uid, subject: (parsed.subject ?? "").trim(), from: parsedAddr(parsed.from), to: parsedAddr(parsed.to), cc: parsedAddr(parsed.cc),
        replyTo: parsedAddr(parsed.replyTo), date: parsed.date ? parsed.date.toISOString() : "", messageId: parsed.messageId ?? "",
        references: (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).slice(-20),
        text: ((parsed.text ?? "").trim() ? parsed.text ?? "" : rawHtml ? htmlToPlain(rawHtml) : "").slice(0, 500_000), html: clean ? clean.html : null, blockedImages: clean?.blocked ?? 0,
        attachments: atts.map((a, index) => ({ index, filename: a.filename ?? "", contentType: a.contentType, size: a.size, cid: a.cid ? a.cid.replace(/^<|>$/g, "").toLowerCase() : "" }))
          .filter((a) => !(a.cid && usedCids.has(a.cid)))
          .map(({ cid: _c, ...a }) => a),
        seen: true, flagged: Boolean(meta.flags?.has("\\Flagged")), answered: Boolean(meta.flags?.has("\\Answered")),
      };
    } finally { lock.release(); }
  });
}

/** Anhang (Index wie in readMessage) */
export async function readAttachment(path: string, uid: number, index: number) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const { parsed } = await parseMessage(c, uid);
      const a = parsed.attachments?.[index];
      if (!a) throw new MailboxError("notFound");
      return { filename: a.filename ?? "", contentType: a.contentType || "application/octet-stream", content: a.content };
    } finally { lock.release(); }
  });
}

/** Original-Anhänge zum Weiterleiten */
export async function attachmentsOf(path: string, uid: number) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(path, { readOnly: true });
    try {
      const { parsed } = await parseMessage(c, uid);
      return (parsed.attachments ?? []).map((a) => ({ filename: a.filename ?? "anhang", content: a.content, contentType: a.contentType }));
    } finally { lock.release(); }
  });
}

export async function setFlags(path: string, uid: number, f: { seen?: boolean; flagged?: boolean }) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(path);
    try {
      const add: string[] = [], remove: string[] = [];
      if (f.seen !== undefined) (f.seen ? add : remove).push("\\Seen");
      if (f.flagged !== undefined) (f.flagged ? add : remove).push("\\Flagged");
      if (add.length) await c.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(String(uid), remove, { uid: true });
      forgetUnread();
    } finally { lock.release(); }
  });
}

/** „Löschen“ = in den Papierkorb des Postfachs (nie endgültig; im Papierkorb selbst bleibt sie liegen) */
export async function moveToTrash(path: string, uid: number, userId?: string) {
  const r = await withImap(async (c) => {
    const trash = (await folders(c)).find((f) => f.role === "trash");
    if (!trash) throw new MailboxError("notFound", "trash");
    if (trash.path === path) return { moved: false };
    const lock = await c.getMailboxLock(path);
    try {
      const res = await c.messageMove(String(uid), trash.path, { uid: true });
      return { moved: Boolean(res) };
    } finally { lock.release(); }
  });
  await db.insert(schema.auditLog).values({ entity: "mail", entityId: `${path}#${uid}`, action: "trash", userId: userId ?? null, after: r });
  forgetUnread();
  return r;
}

// ───────────────────────── Senden ─────────────────────────

export type SendInput = {
  to: string[]; cc: string[]; subject: string; text: string;
  /** Signatur mit Logo (aus den Einstellungen) unter den Text setzen – nur wenn eine hinterlegt ist */
  withSignature?: boolean;
  attachments: { filename: string; content: Buffer; contentType?: string }[];
  inReplyTo?: string; references?: string[]; answered?: { path: string; uid: number };
};

/** Senden per SMTP, danach Kopie in „Gesendet“ (gleiche Message-ID; legt keine doppelte an, falls der Server selbst ablegt) */
export async function sendFromMailbox(input: SendInput, userId?: string): Promise<{ messageId: string; savedToSent: boolean }> {
  const s = await active();
  if (!input.to.length) throw new MailboxError("invalid", "to");
  const company = await db.query.companySettings.findFirst({ columns: { name: true } });
  const domain = s.user.split("@")[1] || "starstyle.local";
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const bodies = buildMailBodies(input.text, input.withSignature && s.signatureHtml ? { html: s.signatureHtml, text: htmlToPlain(s.signatureHtml).replace(/\n{2,}/g, "\n") } : null);
  const options = {
    from: { name: s.fromName || company?.name || "Star Style", address: s.user },
    to: input.to, cc: input.cc.length ? input.cc : undefined, subject: input.subject, text: bodies.text, ...(bodies.html ? { html: bodies.html } : {}),
    attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    messageId, date: new Date(),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: [...(input.references ?? []), input.inReplyTo].slice(-20) } : {}),
  };
  const transport = nodemailer.createTransport({
    host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.user, pass: s.password },
    connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  });
  try { await transport.sendMail(options); } catch (e) { const m = classify(e); throw m.code === "auth" ? m : new MailboxError("send", m.message); }

  let savedToSent = false;
  try {
    const raw = await new MailComposer(options).compile().build();
    savedToSent = await withImap(async (c) => {
      const sent = (await folders(c)).find((f) => f.role === "sent");
      if (!sent) return false;
      await new Promise((r) => setTimeout(r, 1200));
      const lock = await c.getMailboxLock(sent.path);
      try {
        const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
        if (found && found.length) return true;
        await c.append(sent.path, raw, ["\\Seen"]);
        return true;
      } finally { lock.release(); }
    }, s);
  } catch { savedToSent = false; }
  if (input.answered) {
    try {
      await withImap(async (c) => {
        const lock = await c.getMailboxLock(input.answered!.path);
        try { await c.messageFlagsAdd(String(input.answered!.uid), ["\\Answered"], { uid: true }); } finally { lock.release(); }
      }, s);
    } catch { /* nur Markierung */ }
  }
  await db.insert(schema.auditLog).values({
    entity: "mail", entityId: messageId, action: "send", userId: userId ?? null,
    after: { to: input.to, cc: input.cc, subject: input.subject.slice(0, 200), attachments: input.attachments.map((a) => `${a.filename} (${a.content.length})`), savedToSent },
  });
  return { messageId, savedToSent };
}

/** Verbindung prüfen: IMAP anmelden + SMTP anmelden (sendet nichts) */
export async function testMailbox(): Promise<{ ok: true; total: number; unseen: number } | { ok: false; code: string; message: string }> {
  try {
    const s = await active();
    const st = await withImap(async (c) => c.status("INBOX", { messages: true, unseen: true }), s);
    const transport = nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.user, pass: s.password }, connectionTimeout: 20_000, greetingTimeout: 15_000 });
    try { await transport.verify(); } catch (e) { const m = classify(e); return { ok: false, code: m.code === "auth" ? "smtpAuth" : "smtp", message: m.message }; }
    return { ok: true, total: st ? st.messages ?? 0 : 0, unseen: st ? st.unseen ?? 0 : 0 };
  } catch (e) {
    const m = classify(e);
    return { ok: false, code: m.code, message: m.message };
  }
}

// ───────────────────────── Ungelesen (Zahl im Menü) ─────────────────────────

type UnreadCache = { at: number; value: number | null; busy?: Promise<void> };
const g = globalThis as unknown as { __ssMailUnread?: UnreadCache };
function forgetUnread() { if (g.__ssMailUnread) g.__ssMailUnread.at = 0; }
function refreshUnreadSoon() { forgetUnread(); }

/** Ungelesene im Posteingang – höchstens alle 60 s neu gefragt; null = nicht eingerichtet/nicht erreichbar */
export async function inboxUnread(): Promise<number | null> {
  const c = (g.__ssMailUnread ??= { at: 0, value: null });
  if (Date.now() - c.at < 60_000) return c.value;
  if (!c.busy) {
    c.busy = (async () => {
      try {
        if (!(await mailboxConfigured())) { c.value = null; return; }
        const st = await withImap((x) => x.status("INBOX", { unseen: true }));
        c.value = st ? st.unseen ?? 0 : null;
      } catch { c.value = null; } finally { c.at = Date.now(); c.busy = undefined; }
    })();
  }
  await c.busy;
  return c.value;
}
