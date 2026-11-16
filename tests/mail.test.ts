import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  folderRole, forwardSubject, humanSize, inlineSafe, mailboxReady, pageRange, parseAddressList, parseMailSettings, quoteText,
  replySubject, safeFilename, validHost,
} from "../src/lib/mail-rules";

// Postfach info@ im System (Wunsch Inhaber 16.11.2026)
describe("E-Mail – reine Regeln", () => {
  it("Nur-HTML → Text (ohne Skripte/Styles, Zeilen bleiben)", async () => {
    const { htmlToPlain } = await import("../src/lib/mailbox");
    expect(htmlToPlain("<style>p{}</style><h1>Hallo</h1><p>A &amp; B<br>C&nbsp;D</p><script>x()</script><div>مرحبا</div>")).toBe("Hallo\nA & B\nC D\nمرحبا");
  });

  it("Einstellungen: Hostinger-Standard, nie werfen, Benutzer aus der Firmen-E-Mail", () => {
    const s = parseMailSettings(null, "Info@StarStyle-Shop.de");
    expect(s).toMatchObject({ imapHost: "imap.hostinger.com", imapPort: 993, smtpHost: "smtp.hostinger.com", smtpPort: 465, user: "info@starstyle-shop.de", password: "" });
    expect(mailboxReady(s)).toBe(false);
    expect(parseMailSettings({ imapHost: "bad host!", imapPort: 99999, user: "x@y.de", password: "v1.a.b.c" })).toMatchObject({ imapHost: "imap.hostinger.com", imapPort: 993, user: "x@y.de" });
    expect(mailboxReady(parseMailSettings({ user: "x@y.de", password: "v1.a.b.c" }))).toBe(true);
    expect(validHost("127.0.0.1")).toBe(true);
    expect(validHost("localhost")).toBe(false);
  });

  it("Adressen: Namen, Trennzeichen, Doppelte, ungültige", () => {
    expect(parseAddressList("Salon <A@x.de>, b@y.de; a@x.de\nfalsch")).toEqual({ ok: ["a@x.de", "b@y.de"], bad: ["falsch"] });
    expect(parseAddressList("").ok).toEqual([]);
    expect(parseAddressList(Array.from({ length: 22 }, (_, i) => `k${i}@x.de`).join(","), 20).bad).toHaveLength(2);
  });

  it("Betreff, Zitat, Weiterleiten", () => {
    expect(replySubject("AW: Re: Bestellung")).toBe("Re: Bestellung");
    expect(replySubject("")).toBe("Re: (ohne Betreff)");
    expect(forwardSubject("WG: Angebot")).toBe("Fwd: Angebot");
    expect(quoteText("Hallo\n> alt", "Salon <s@x.de>", "16.11.2026")).toBe("\n\n\nAm 16.11.2026 schrieb Salon <s@x.de>:\n> Hallo\n>> alt\n");
  });

  it("Dateinamen und Anzeige im Browser", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename('a"b<c>.pdf')).toBe("abc.pdf");
    expect(safeFilename("")).toBe("anhang");
    expect(inlineSafe("image/png")).toBe(true);
    expect(inlineSafe("image/svg+xml")).toBe(false);
    expect(inlineSafe("text/html")).toBe(false);
    expect(inlineSafe("application/pdf")).toBe(false);
    expect(humanSize(1536 * 1024)).toBe("1,5 MB");
  });

  it("Ordner erkennen und Seiten (neueste zuerst)", () => {
    expect(folderRole("INBOX")).toBe("inbox");
    expect(folderRole("INBOX.Sent", "\\Sent")).toBe("sent");
    expect(folderRole("Gesendete Objekte")).toBe("sent");
    expect(folderRole("Papierkorb")).toBe("trash");
    expect(folderRole("Kunden")).toBe("other");
    expect(pageRange(120, 1, 50)).toEqual({ from: 71, to: 120 });
    expect(pageRange(120, 3, 50)).toEqual({ from: 1, to: 20 });
    expect(pageRange(120, 4, 50)).toBeNull();
    expect(pageRange(0, 1)).toBeNull();
  });
});

const run = process.env.DATABASE_URL && process.env.SESSION_SECRET ? describe : describe.skip;

run("E-Mail – Postfach mit simuliertem Mailserver (IMAP + SMTP)", () => {
  const USER = "info@starstyle.test", PASS = "test-app-pass-1";
  const received: { to: string[]; raw: string }[] = [];
  let imap: { close: (cb?: () => void) => void; listen: (p: number, h: string, cb: () => void) => void };
  let smtp: { close: (cb?: () => void) => void; listen: (p: number, h: string, cb: () => void) => void };
  let before: unknown;
  let mb: typeof import("../src/lib/mailbox");
  const IMAP_PORT = 21143, SMTP_PORT = 21025;

  beforeAll(async () => {
    const { db, schema } = await import("../src/db");
    await db.insert(schema.companySettings).values({ id: "company", name: "Test GmbH" }).onConflictDoNothing();
    before = (await db.query.companySettings.findFirst())?.mail;
    const imapkit = (await import("imapkit")).default as unknown as (o: unknown) => typeof imap;
    const { SMTPServer } = await import("smtp-server");
    const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
    imap = imapkit({
      plugins: ["ID", "IDLE", "MOVE", "SPECIAL-USE", "UIDPLUS", "ENABLE", "LITERALPLUS", "UNSELECT", "NAMESPACE"],
      users: { [USER]: { password: PASS } },
      storage: {
        INBOX: { messages: [{ raw: crlf(`From: "Salon Amal" <kunde@salon.test>\nTo: ${USER}\nSubject: Bestellung\nMessage-ID: <o1@salon.test>\nContent-Type: text/html; charset=utf-8\n\n<p>Hallo <b>Star Style</b></p><img src="https://tracker.test/p.gif"><script>alert(1)</script><a href="https://x.test" onclick="evil()">Link</a>\n`), flags: [], internaldate: "16-Nov-2026 10:00:00 +0100" }] },
        "": { separator: "/", folders: { Sent: { "special-use": "\\Sent" }, Trash: { "special-use": "\\Trash" } } },
      },
    });
    await new Promise<void>((r) => imap.listen(IMAP_PORT, "127.0.0.1", r));
    smtp = new SMTPServer({
      secure: false, disabledCommands: ["STARTTLS"],
      onAuth(a, _s, cb) { if (a.username === USER && a.password === PASS) cb(null, { user: USER }); else cb(new Error("Invalid username or password")); },
      onData(stream, s, cb) { const c: Buffer[] = []; stream.on("data", (d: Buffer) => c.push(d)); stream.on("end", () => { received.push({ to: s.envelope.rcptTo.map((x) => x.address), raw: Buffer.concat(c).toString("utf8") }); cb(); }); },
    }) as unknown as typeof smtp;
    await new Promise<void>((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));
    mb = await import("../src/lib/mailbox");
  });

  afterAll(async () => {
    const { db, schema } = await import("../src/db");
    await db.update(schema.companySettings).set({ mail: (before ?? {}) as Record<string, unknown> }).where(eq(schema.companySettings.id, "company"));
    await new Promise<void>((r) => imap?.close(() => r()));
    await new Promise<void>((r) => smtp?.close(() => r()));
  });

  it("falsches Passwort: gespeichert, Prüfung meldet auth; richtiges: verschlüsselt, verbunden", async () => {
    const base = { imapHost: "127.0.0.1", imapPort: IMAP_PORT, smtpHost: "127.0.0.1", smtpPort: SMTP_PORT, user: USER, fromName: "Star Style", signature: "" };
    expect(await mb.saveMailSettings({ ...base, password: "falsch" })).toEqual({ ok: true });
    expect(await mb.testMailbox()).toMatchObject({ ok: false, code: "auth" });
    expect(await mb.saveMailSettings({ ...base, password: PASS })).toEqual({ ok: true });
    const s = await mb.loadMailSettings();
    expect(s.password.startsWith("v1.")).toBe(true);
    expect(s.password).not.toContain(PASS);
    expect(await mb.testMailbox()).toEqual({ ok: true, total: 1, unseen: 1 });
    // leeres Passwort beim Speichern = altes bleibt
    expect(await mb.saveMailSettings({ ...base, password: "" })).toEqual({ ok: true });
    expect(await mb.testMailbox()).toMatchObject({ ok: true });
    const { db, schema } = await import("../src/db");
    const log = await db.query.auditLog.findMany({ where: eq(schema.auditLog.entityId, "mail") });
    expect(JSON.stringify(log)).not.toContain(PASS); // nie das Passwort ins Protokoll
  }, 30_000);

  it("lesen: HTML ohne Skripte/Zählpixel, öffnen = gelesen; antworten mit Bezug + Kopie in „Gesendet“; Papierkorb", async () => {
    const list = await mb.listMessages("INBOX");
    expect(list.items).toHaveLength(1);
    expect(list.folders.map((f) => f.role)).toEqual(["inbox", "sent", "trash"]);
    const m = await mb.readMessage("INBOX", list.items[0].uid);
    expect(m.html).toContain("<b>Star Style</b>");
    expect(m.html).not.toMatch(/<script|onclick|tracker\.test/);
    expect(m.blockedImages).toBe(1);
    expect(m.text).toContain("Hallo Star Style"); // Nur-HTML: Text zum Zitieren
    expect(m.text).not.toContain("alert(1)");
    expect((await mb.listMessages("INBOX")).items[0].seen).toBe(true);
    const r = await mb.sendFromMailbox({ to: ["kunde@salon.test"], cc: [], subject: "Re: Bestellung", text: "Danke!", attachments: [], inReplyTo: m.messageId, references: m.references, answered: { path: "INBOX", uid: m.uid } });
    expect(r.savedToSent).toBe(true);
    expect(received.at(-1)?.to).toEqual(["kunde@salon.test"]);
    expect(received.at(-1)?.raw).toMatch(/In-Reply-To: <o1@salon\.test>/);
    expect((await mb.listMessages("Sent")).items.map((x) => x.subject)).toEqual(["Re: Bestellung"]);
    expect((await mb.listMessages("INBOX")).items[0].answered).toBe(true);
    expect(await mb.moveToTrash("INBOX", m.uid)).toEqual({ moved: true });
    expect((await mb.listMessages("INBOX")).items).toHaveLength(0);
    expect((await mb.listMessages("Trash")).items).toHaveLength(1);
  }, 30_000);

  it("Zugang entfernen: nichts mehr lesbar, Postfach selbst unverändert", async () => {
    await mb.saveMailSettings({ imapHost: "", imapPort: 0, smtpHost: "", smtpPort: 0, user: "", password: "", fromName: "", signature: "", disconnect: true });
    expect(await mb.mailboxConfigured()).toBe(false);
    await expect(mb.listFolders()).rejects.toMatchObject({ code: "notConfigured" });
  });
});
