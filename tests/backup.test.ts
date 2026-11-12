import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  BackupFormatError, END_LINE, HEADER_LEN, TAG_LEN, backupFileName, backupKey, encryptStream, ident, readLines, sameRow, tableLine, tableOrder,
} from "../src/lib/backup-format";

// Datensicherung (Wunsch Inhaber 12.11.2026): verschlüsselte Datei, nur dieses System kann sie öffnen, Manipulation fällt auf
const KEY = backupKey("test-secret-0123456789abcdefghijklmnopqrstuvwxyz");
const dir = mkdtempSync(join(tmpdir(), "ssbk-"));

async function makeFile(lines: string[], key = KEY): Promise<string> {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.ssbak`);
  await pipeline(Readable.from(lines.map((l) => l + "\n")), createGzip(), encryptStream(key), createWriteStream(p));
  return p;
}
const readAll = async (p: string, key = KEY) => { const out: string[] = []; await readLines(p, key, (l) => { out.push(l); }); return out; };

describe("Datensicherung – Dateiformat (rein)", () => {
  const lines = ['{"kind":"star-style-backup"}', tableLine("customers", ["id", "name"]), '{"id":"a","name":"Ali \\"Ä\\" علي"}', END_LINE];

  it("hin und zurück: dieselben Zeilen (auch Umlaute/Arabisch, große Zeilen)", async () => {
    const big = JSON.stringify({ id: "f", data: "\\x" + "ab".repeat(3_000_000) });
    const p = await makeFile([...lines.slice(0, 3), big, END_LINE]);
    expect(await readAll(p)).toEqual([...lines.slice(0, 3), big, END_LINE]);
    const raw = readFileSync(p);
    expect(raw.subarray(0, 4).toString()).toBe("SSBK");
    expect(raw.includes(Buffer.from("customers"))).toBe(false); // nichts im Klartext
  });

  it("anderes System (anderer Schlüssel), verändert, abgeschnitten, Unsinn → „keine gültige Sicherung“", async () => {
    const p = await makeFile(lines);
    await expect(readAll(p, backupKey("ein-ganz-anderes-geheimnis-0123456789abcdef"))).rejects.toThrow(BackupFormatError);
    const raw = readFileSync(p);
    const flipped = Buffer.from(raw); flipped[HEADER_LEN + 3] ^= 0x01;
    const p2 = join(dir, "flip.ssbak"); writeFileSync(p2, flipped);
    await expect(readAll(p2)).rejects.toThrow(BackupFormatError);
    const p3 = join(dir, "cut.ssbak"); writeFileSync(p3, raw.subarray(0, raw.length - TAG_LEN - 5));
    await expect(readAll(p3)).rejects.toThrow(BackupFormatError);
    const p4 = join(dir, "junk.ssbak"); writeFileSync(p4, Buffer.from("hallo, das ist keine Sicherung"));
    await expect(readAll(p4)).rejects.toThrow(BackupFormatError);
  });

  it("Fehler beim Verarbeiten einer Zeile kommen unverändert durch (z. B. Datenbank)", async () => {
    const p = await makeFile(lines);
    await expect(readLines(p, KEY, () => { throw new Error("db kaputt"); })).rejects.toThrow("db kaputt");
  });

  it("Reihenfolge: erst die Tabellen, auf die verwiesen wird; Kreis = Fehler", () => {
    const order = tableOrder(["invoice_lines", "invoices", "customers", "variants", "products", "offers"], [
      { from: "invoice_lines", to: "invoices" }, { from: "invoice_lines", to: "variants" }, { from: "invoices", to: "customers" },
      { from: "invoices", to: "offers" }, { from: "offers", to: "customers" }, { from: "variants", to: "products" },
    ]);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    expect(before("customers", "invoices") && before("offers", "invoices") && before("invoices", "invoice_lines") && before("products", "variants")).toBe(true);
    expect(() => tableOrder(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toThrow();
    expect(tableOrder(["x"], [{ from: "x", to: "x" }])).toEqual(["x"]);
  });

  it("Zeilen vergleichen (Sperre im Echtbetrieb): neue Spalten zählen nicht, Zeitstempel nach Zeitpunkt", () => {
    const a = JSON.stringify({ id: "p1", amount_cents: 500, cancelled_at: null, created_at: "2026-11-12T10:00:00.123+00:00", meta: { a: 1 } });
    expect(sameRow(a, a)).toBe(true);
    expect(sameRow(a, a.replace("500", "400"))).toBe(false);
    expect(sameRow(a, a.replace('"cancelled_at":null', '"cancelled_at":"2026-11-13T08:00:00+00:00"'))).toBe(false); // seitdem storniert
    expect(sameRow(a, a.replace("+00:00", "Z"))).toBe(true);
    expect(sameRow(a, a.replace("10:00:00.123+00:00", "11:00:00.123+01:00"))).toBe(true);
    expect(sameRow(a, a.replace("10:00:00.123", "10:00:01.123"))).toBe(false);
    expect(sameRow(a, JSON.stringify({ ...JSON.parse(a), sent_at: "2026-11-13T08:00:00+00:00" }))).toBe(true); // Spalte erst nach der Sicherung dazugekommen
    expect(sameRow(a, a.replace('{"a":1}', '{"a":2}'))).toBe(false);
  });

  it("Bezeichner nur aus dem Katalog, sicher gequotet; Dateiname mit deutscher Zeit", () => {
    expect(ident("stored_files")).toBe('"stored_files"');
    expect(() => ident('x"; drop table users; --')).toThrow();
    expect(backupFileName(new Date("2026-11-12T22:55:00Z"))).toBe("StarStyle-Sicherung-2026-11-12_2355.ssbak");
  });
});

/**
 * Rundlauf mit echter Datenbank: sichern → ändern → zurückholen → alles wieder wie vorher (Protokolle bleiben + Eintrag „restore“).
 * Leert und füllt ALLE Tabellen → nur mit BACKUP_DB_TEST=1 auf einer eigenen Kopie (createdb -T ss_test ss_backup_test).
 */
const run = process.env.DATABASE_URL && process.env.BACKUP_DB_TEST === "1" ? describe : describe.skip;

run("Datensicherung – Rundlauf mit Datenbank", () => {
  it("sichern, ändern, prüfen, zurückholen = gleicher Stand", async () => {
    process.env.SESSION_SECRET ||= "local-test-secret-0123456789abcdefghijklmnop";
    const { db } = await import("../src/db");
    const { sql } = await import("drizzle-orm");
    const { writeBackup, inspectBackup, restoreBackup, MERGE_TABLES } = await import("../src/lib/backup");
    const tables = (await db.execute<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.t);
    const fingerprint = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) {
        if (MERGE_TABLES.has(t)) continue;
        const r = await db.execute<{ n: number; h: string }>(sql.raw(`select count(*)::int as n, md5(coalesce(string_agg(row_to_json(x)::text, '|' order by row_to_json(x)::text), '')) as h from "${t}" x`));
        out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
      }
      const seq = await db.execute<{ v: string }>(sql`select last_value::text as v from customers_number_seq`);
      out.seq = seq.rows[0].v;
      return out;
    };
    const admin = (await db.execute<{ id: string }>(sql`select id from users where is_admin and active order by created_at limit 1`)).rows[0];
    expect(admin).toBeTruthy();
    const before = await fingerprint();
    const path = join(dir, "db.ssbak");
    const st = await writeBackup(createWriteStream(path), "Test");
    expect(st.tables).toBe(tables.length);
    const size = readFileSync(path).length;

    // ändern: neuer Kunde (Nummer aus der Sequenz), Preis geändert, Protokollzeile, Konten (Passwort geändert, neuer Mitarbeiter)
    await db.execute(sql`insert into customers (id, name) values (gen_random_uuid()::text, 'Nach der Sicherung')`);
    await db.execute(sql`update products set retail_price_cents = retail_price_cents + 1 where id = (select id from products order by id limit 1)`);
    await db.execute(sql`insert into audit_log (id, entity, entity_id, action) values (gen_random_uuid()::text, 'test', 'x', 'after-backup')`);
    const oldHash = (await db.execute<{ h: string }>(sql`select password_hash as h from users where id = ${admin.id}`)).rows[0].h;
    await db.execute(sql`update users set password_hash = 'neu-nach-der-sicherung' where id = ${admin.id}`);
    const staffMail = `bk-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await db.execute(sql`insert into users (id, email, name, password_hash) values (gen_random_uuid()::text, ${staffMail}, 'Neu nach Sicherung', 'x')`);
    expect((await fingerprint()).customers).not.toBe(before.customers);

    const live0 = (await db.execute<{ v: string | null }>(sql`select live_since::text as v from company_settings limit 1`)).rows[0]?.v ?? null;
    const locks = (await db.execute<{ n: number }>(sql`select count(*)::int as n from period_locks`)).rows[0].n;
    const s = await inspectBackup(path, admin.id, size);
    expect(s.blocked).toBe(live0 || locks ? "live" : null);
    expect(s.counts.products).toBeGreaterThan(0);

    try {
      const r = await restoreBackup(path, admin.id);
      expect(r.rows).toBeGreaterThan(0);
      expect(await fingerprint()).toEqual(before);
      const log = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where action in ('after-backup', 'restore')`);
      expect(log.rows[0].n).toBeGreaterThanOrEqual(2); // Protokoll nie zurückgedreht
      // Konten bleiben wie jetzt: geändertes Passwort gilt weiter, neuer Mitarbeiter bleibt
      expect((await db.execute<{ h: string }>(sql`select password_hash as h from users where id = ${admin.id}`)).rows[0].h).toBe("neu-nach-der-sicherung");
      expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from users where email = ${staffMail}`)).rows[0].n).toBe(1);

      // Echtbetrieb: Sicherung aus dem Testbetrieb → gesperrt
      if (!live0 && !locks) {
        await db.execute(sql`update company_settings set live_since = now()`);
        expect((await inspectBackup(path, admin.id, size)).blocked).toBe("testBackup");
        // Sicherung im Echtbetrieb → frei; danach eine Zahlung storniert / ein Monat abgeschlossen → gesperrt
        const live = join(dir, "live.ssbak");
        await writeBackup(createWriteStream(live), "Test");
        const lsize = readFileSync(live).length;
        expect((await inspectBackup(live, admin.id, lsize)).blocked).toBe(null);
        await db.execute(sql`insert into period_locks (month, locked_at) values ('1999-01', now())`);
        const l2 = await inspectBackup(live, admin.id, lsize);
        expect(l2.blocked).toBe("live");
        expect(l2.lost.changed).toBe(1);
        await db.execute(sql`delete from period_locks where month = '1999-01'`);
        const pay = (await db.execute<{ id: string }>(sql`select id from payments where cancelled_at is null limit 1`)).rows[0];
        if (pay) {
          await db.execute(sql`update payments set cancelled_at = now(), cancel_reason = 'Test' where id = ${pay.id}`);
          expect((await inspectBackup(live, admin.id, lsize)).blocked).toBe("live");
          await db.execute(sql`update payments set cancelled_at = null, cancel_reason = '' where id = ${pay.id}`);
        }
        expect((await inspectBackup(live, admin.id, lsize)).blocked).toBe(null);
        await db.execute(sql`update company_settings set live_since = null`);
      }
    } finally {
      await db.execute(sql`update users set password_hash = ${oldHash} where id = ${admin.id}`);
      await db.execute(sql`delete from users where email = ${staffMail}`);
    }
  }, 300_000);
});
