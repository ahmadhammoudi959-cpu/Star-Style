import "server-only";
/**
 * Datensicherung (Wunsch Inhaber 12.11.2026: „باك اب يومي، ينزل عاللابتوب، وإذا صار شي بيرفعه وبيرجع لنسخة امبارح“).
 * - Sichern: EIN Schnappschuss aller Tabellen (REPEATABLE READ = alles vom selben Augenblick) als verschlüsselte Datei,
 *   direkt in die Antwort gestreamt (nichts wird auf dem Server gespeichert, wenig Arbeitsspeicher). Fotos/Belege/PDFs
 *   liegen in stored_files und sind damit dabei.
 * - Zurückholen: Datei in Stücken hochladen → prüfen (Prüfwert, Version, Admin-Konto, was seitdem neu ist) → in EINER
 *   Transaktion alles leeren und aus der Datei füllen; bestätigt wird erst, wenn der Prüfwert am Dateiende stimmt.
 *   Protokolle (audit_log, login_attempts, shop_events) und Konten (users) werden nie zurückgedreht, nur ergänzt: Passwörter,
 *   Sperren, Rechte und Zwei-Schritt bleiben wie jetzt (sonst wäre ein gesperrter Mitarbeiter oder ein altes Passwort wieder da).
 *   Echtbetrieb: gesperrt, wenn seitdem Rechnungen, Zahlungen, Monatsabschlüsse oder Monatsmappen dazukamen oder sich geändert
 *   haben (gebuchte Belege nie löschen oder zurückdrehen, GoBD), und für Sicherungen aus dem Testbetrieb.
 */
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Readable, type Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { db } from "@/db";
import {
  BackupFormatError, END_LINE, TABLE_PREFIX, backupKey, encryptStream, ident, readLines, sameRow, tableLine, tableOrder, type Manifest,
} from "./backup-format";
import { liveStatus } from "./test-reset";
import { STATUS_SQL } from "./test-reset-sql";
import { forgetAllSessions } from "./session-check";

/** Protokolle und Konten: beim Zurückholen behalten und nur ergänzen (fehlende Zeilen aus der Sicherung, z. B. nach Datenverlust) */
export const MERGE_TABLES = new Set(["audit_log", "login_attempts", "shop_events", "users"]);
const BIG_TABLES = new Set(["stored_files", "advisor_exports"]);

const pool = () => db.$client as unknown as Pool;
const fileKey = () => backupKey(process.env.SESSION_SECRET ?? "");

type Catalog = { tables: string[]; columns: Map<string, string[]> };

async function catalog(c: PoolClient): Promise<Catalog> {
  const [t, f, col] = await Promise.all([
    c.query<{ name: string }>(`select tablename as name from pg_tables where schemaname = 'public'`),
    c.query<{ from: string; to: string }>(`
      select cl.relname as "from", cf.relname as "to" from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid join pg_class cf on cf.oid = k.confrelid
      where k.contype = 'f' and k.connamespace = 'public'::regnamespace`),
    c.query<{ t: string; c: string }>(`
      select table_name as t, column_name as c from information_schema.columns
      where table_schema = 'public' and is_generated = 'NEVER' order by table_name, ordinal_position`),
  ]);
  const columns = new Map<string, string[]>();
  for (const r of col.rows) columns.set(r.t, [...(columns.get(r.t) ?? []), r.c]);
  return { tables: tableOrder(t.rows.map((r) => r.name), f.rows), columns };
}

async function migrationCount(c: PoolClient): Promise<number> {
  try { return Number((await c.query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n ?? 0); }
  catch { return 0; }
}

async function sequences(c: PoolClient): Promise<Manifest["sequences"]> {
  const names = (await c.query<{ n: string }>(`select sequencename as n from pg_sequences where schemaname = 'public' order by 1`)).rows.map((r) => r.n);
  const out: Manifest["sequences"] = {};
  for (const n of names) {
    const r = (await c.query<{ v: string; called: boolean }>(`select last_value::text as v, is_called as called from ${ident(n)}`)).rows[0];
    out[n] = { value: Number(r.v), called: r.called };
  }
  return out;
}

/**
 * In den gzip-Strom schreiben, mit Gegendruck; bricht ab, wenn der Empfänger weg ist (Download abgebrochen).
 * Die Warte-Listener werden danach wieder entfernt (AbortSignal) – sonst sammeln sich bei großen Sicherungen tausende an.
 */
async function writeTo(s: Writable, chunk: string) {
  if (s.destroyed) throw new Error("aborted");
  if (s.write(chunk)) return;
  const ac = new AbortController();
  try {
    await Promise.race([
      once(s, "drain", { signal: ac.signal }),
      once(s, "close", { signal: ac.signal }).then(() => { throw new Error("aborted"); }),
    ]);
  } finally { ac.abort(); }
}

export type BackupStats = { rows: number; files: number; tables: number };

/** Ganze Datenbank als verschlüsselte Sicherung in `out` schreiben (Antwort des Downloads) */
export async function writeBackup(out: Writable, createdBy: string): Promise<BackupStats> {
  const c = await pool().connect();
  const gzip = createGzip({ level: 6 });
  const done = pipeline(gzip, encryptStream(fileKey()), out);
  done.catch(() => {}); // Fehler kommen unten über writeTo/await done
  let rows = 0, files = 0;
  try {
    await c.query("begin isolation level repeatable read read only");
    const cat = await catalog(c);
    const counts: Manifest["tables"] = [];
    for (const t of cat.tables) counts.push({ name: t, rows: Number((await c.query<{ n: string }>(`select count(*)::text as n from ${ident(t)}`)).rows[0].n) });
    const live = (await c.query<{ live: boolean }>(STATUS_SQL)).rows[0]?.live ?? false; // wie liveStatus(): Echtbetrieb oder abgeschlossener Monat
    const manifest: Manifest = {
      kind: "star-style-backup", format: 1, createdAt: new Date().toISOString(), createdBy,
      migrations: await migrationCount(c), live, tables: counts, sequences: await sequences(c),
    };
    await writeTo(gzip, JSON.stringify(manifest) + "\n");
    for (const t of cat.tables) {
      await writeTo(gzip, tableLine(t, cat.columns.get(t) ?? []) + "\n");
      await c.query(`declare bk no scroll cursor for select row_to_json(x)::text as j from ${ident(t)} x`);
      const n = BIG_TABLES.has(t) ? 4 : 500;
      for (;;) {
        const r = await c.query<{ j: string }>(`fetch ${n} from bk`);
        if (!r.rows.length) break;
        for (const row of r.rows) await writeTo(gzip, row.j + "\n");
        rows += r.rows.length;
        if (t === "stored_files") files += r.rows.length;
      }
      await c.query("close bk");
    }
    await writeTo(gzip, END_LINE + "\n");
    await c.query("commit");
    gzip.end();
    await done;
    return { rows, files, tables: cat.tables.length };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    gzip.destroy();
    throw e;
  } finally {
    c.release();
  }
}

// ───────────────────────── Prüfen ─────────────────────────

export type BackupSummary = {
  createdAt: string; createdBy: string; bytes: number;
  /** jetzt im Echtbetrieb (oder Monat abgeschlossen) / Sicherung aus dem Echtbetrieb */
  live: boolean; backupLive: boolean;
  counts: { products: number; variants: number; customers: number; invoices: number; files: number };
  /** seit der Sicherung neu – geht beim Zurückholen verloren; changed = seitdem geänderte Rechnungen/Zahlungen/Monatsabschlüsse */
  lost: { invoices: string[]; payments: number; exports: number; changed: number };
  blocked: null | "live" | "testBackup" | "newer";
};

const count = (m: Manifest, t: string) => m.tables.find((x) => x.name === t)?.rows ?? 0;

/** Datei ganz lesen und prüfen (Prüfwert stimmt erst am Ende), ohne etwas zu ändern */
export async function inspectBackup(path: string, _actorId: string, bytes: number): Promise<BackupSummary> {
  let manifest: Manifest | null = null, table = "", ended = false;
  // gebuchte Daten der Sicherung (für „was geht verloren“ und die Sperre im Echtbetrieb): ausgestellte Rechnungen, Zahlungen,
  // Monatsabschlüsse als ganze Zeile; Monatsmappen nur die ID (Zeilen enthalten die ZIP-Datei)
  const bk = { invoices: new Map<string, string>(), payments: new Map<string, string>(), locks: new Map<string, string>(), exports: new Set<string>() };
  await readLines(path, fileKey(), (line) => {
    if (!manifest) {
      const m = JSON.parse(line) as Manifest;
      if (m.kind !== "star-style-backup" || !Array.isArray(m.tables)) throw new BackupFormatError("invalid");
      manifest = m;
      return;
    }
    if (line === END_LINE) { ended = true; return; }
    if (line.startsWith(TABLE_PREFIX)) { table = (JSON.parse(line) as { $table: string }).$table; return; }
    if (table === "invoices") { const r = JSON.parse(line) as { id: string; number: string | null }; if (r.number) bk.invoices.set(r.id, line); }
    else if (table === "payments") bk.payments.set((JSON.parse(line) as { id: string }).id, line);
    else if (table === "period_locks") bk.locks.set((JSON.parse(line) as { month: string }).month, line);
    else if (table === "advisor_exports") bk.exports.add((JSON.parse(line) as { id: string }).id);
  });
  const m = manifest as Manifest | null;
  if (!m || !ended) throw new BackupFormatError("invalid");
  const c = await pool().connect();
  try {
    const [inv, pay, locks, exp, mig] = await Promise.all([
      c.query<{ id: string; number: string; j: string }>(`select id, number, row_to_json(x)::text as j from invoices x where number is not null order by created_at`),
      c.query<{ id: string; j: string }>(`select id, row_to_json(x)::text as j from payments x`),
      c.query<{ month: string; j: string }>(`select month, row_to_json(x)::text as j from period_locks x`),
      c.query<{ id: string }>(`select id from advisor_exports`),
      migrationCount(c),
    ]);
    const live = (await liveStatus()).live;
    const changedIn = <T extends { j: string }>(rows: T[], key: (r: T) => string, old: Map<string, string>) =>
      rows.filter((r) => old.has(key(r)) && !sameRow(old.get(key(r))!, r.j)).length;
    const lost = {
      invoices: inv.rows.filter((r) => !bk.invoices.has(r.id)).map((r) => r.number),
      payments: pay.rows.filter((r) => !bk.payments.has(r.id)).length,
      exports: exp.rows.filter((r) => !bk.exports.has(r.id)).length,
      // seitdem geändert (z. B. Zahlung storniert, Rechnung storniert/archiviert) oder Monat seitdem abgeschlossen bzw. geöffnet
      changed: changedIn(inv.rows, (r) => r.id, bk.invoices) + changedIn(pay.rows, (r) => r.id, bk.payments)
        + changedIn(locks.rows, (r) => r.month, bk.locks)
        + locks.rows.filter((r) => !bk.locks.has(r.month)).length + [...bk.locks.keys()].filter((k) => !locks.rows.some((r) => r.month === k)).length,
    };
    const blocked = m.migrations > mig ? "newer"
      : live && !m.live ? "testBackup"
        : live && (lost.invoices.length || lost.payments || lost.exports || lost.changed) ? "live" : null;
    return {
      createdAt: m.createdAt, createdBy: m.createdBy, bytes, live, backupLive: !!m.live,
      counts: { products: count(m, "products"), variants: count(m, "variants"), customers: count(m, "customers"), invoices: count(m, "invoices"), files: count(m, "stored_files") },
      lost, blocked,
    };
  } finally { c.release(); }
}

// ───────────────────────── Zurückholen ─────────────────────────

export type RestoreProgress = (done: number, total: number) => void;

export async function restoreBackup(path: string, actorId: string, progress: RestoreProgress = () => {}): Promise<{ rows: number; createdAt: string }> {
  const c = await pool().connect();
  const g = globalThis as { __ssMaintenance?: boolean };
  g.__ssMaintenance = true; // Hintergrund-Abgleich pausieren
  try {
    await c.query("begin");
    await c.query("set local lock_timeout = '30s'");
    const cat = await catalog(c);
    // ohne CASCADE: würde eine behaltene Tabelle auf eine geleerte verweisen, schlägt es fehl, statt sie still mitzuleeren
    await c.query(`truncate ${cat.tables.filter((t) => !MERGE_TABLES.has(t)).map(ident).join(", ")}`);

    let manifest: Manifest | null = null, table = "", cols: string[] = [], skip = false, ended = false;
    let batch: string[] = [], size = 0, done = 0, total = 0;
    const inserted = new Map<string, number>();
    const flush = async () => {
      if (!batch.length) return;
      const list = cols.map(ident).join(", ");
      const r = await c.query(
        `insert into ${ident(table)} (${list}) select ${list} from json_populate_recordset(null::${ident(table)}, $1::json)${MERGE_TABLES.has(table) ? " on conflict do nothing" : ""}`,
        [`[${batch.join(",")}]`],
      );
      inserted.set(table, (inserted.get(table) ?? 0) + (r.rowCount ?? 0));
      done += batch.length;
      progress(done, total);
      batch = []; size = 0;
    };
    await readLines(path, fileKey(), async (line) => {
      if (!manifest) {
        manifest = JSON.parse(line) as Manifest;
        if (manifest.kind !== "star-style-backup") throw new BackupFormatError("invalid");
        total = manifest.tables.reduce((s, x) => s + x.rows, 0);
        return;
      }
      if (line === END_LINE) { await flush(); ended = true; return; }
      if (line.startsWith(TABLE_PREFIX)) {
        await flush();
        const h = JSON.parse(line) as { $table: string; columns: string[] };
        table = h.$table;
        const now = cat.columns.get(table);
        skip = !now; // Tabelle gibt es nicht mehr
        cols = now ? h.columns.filter((x) => now.includes(x)) : [];
        return;
      }
      if (skip) return;
      batch.push(line);
      size += line.length;
      if (batch.length >= 1000 || size > 8_000_000) await flush();
    });
    const m = manifest as Manifest | null;
    if (!m || !ended) throw new BackupFormatError("invalid");
    // vollständig? (Protokolle zählen nicht – dort bleibt Vorhandenes stehen)
    for (const t of m.tables) {
      if (MERGE_TABLES.has(t.name) || !cat.columns.has(t.name)) continue;
      if ((inserted.get(t.name) ?? 0) !== t.rows) throw new Error(`count:${t.name}`);
    }
    for (const [name, s] of Object.entries(m.sequences)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
      await c.query(`select setval($1::regclass, $2, $3)`, [`public.${name}`, Math.max(1, s.value), s.called]).catch(() => {});
    }
    await c.query(
      `insert into audit_log (id, entity, entity_id, action, after, user_id) values (gen_random_uuid()::text, 'backup', $1, 'restore', $2::jsonb, $3)`,
      [m.createdAt, JSON.stringify({ createdAt: m.createdAt, createdBy: m.createdBy, rows: done }), actorId],
    );
    await c.query("commit");
    forgetAllSessions();
    return { rows: done, createdAt: m.createdAt };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    g.__ssMaintenance = false;
    c.release();
  }
}

// ───────────────────────── Hochladen in Stücken + Ablauf ─────────────────────────

const DIR = join(tmpdir(), "star-style-backup");
export const PART_MAX = 8 * 1024 * 1024; // je Stück höchstens 8 MB (Proxy-Grenzen)
const FILE_MAX = 2 * 1024 * 1024 * 1024;

type Upload = { owner: string; next: number; bytes: number; path: string; at: number; summary?: BackupSummary };
type Job = { owner: string; state: "running" | "done" | "failed"; done: number; total: number; error?: string; createdAt?: string };
const g = globalThis as typeof globalThis & { __ssBackupUploads?: Map<string, Upload>; __ssBackupJobs?: Map<string, Job> };
const uploads = (g.__ssBackupUploads ??= new Map());
const jobs = (g.__ssBackupJobs ??= new Map());

export const validUploadId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

async function cleanup() {
  await mkdir(DIR, { recursive: true });
  const now = Date.now();
  for (const f of await readdir(DIR)) {
    const p = join(DIR, f);
    const s = await stat(p).catch(() => null);
    if (s && now - s.mtimeMs > 2 * 3600_000) await rm(p, { force: true });
  }
  for (const [id, u] of uploads) if (now - u.at > 2 * 3600_000) uploads.delete(id);
}

export class UploadError extends Error {
  constructor(public code: "order" | "tooBig" | "expired" | "busy") { super(code); }
}

/** Ein Stück anhängen; beim letzten wird die ganze Datei geprüft und die Zusammenfassung zurückgegeben */
export async function uploadPart(o: { id: string; part: number; last: boolean; owner: string; body: ReadableStream<Uint8Array> }): Promise<BackupSummary | null> {
  if (o.part === 0) {
    await cleanup();
    uploads.set(o.id, { owner: o.owner, next: 0, bytes: 0, path: join(DIR, `${o.id}.ssbak`), at: Date.now() });
  }
  const u = uploads.get(o.id);
  if (!u || u.owner !== o.owner) throw new UploadError("expired");
  if (u.next !== o.part) throw new UploadError("order");
  let n = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      n += chunk.byteLength;
      if (n > PART_MAX || u.bytes + n > FILE_MAX) { ctl.error(new UploadError("tooBig")); return; }
      ctl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(o.body.pipeThrough(limit) as unknown as NodeReadableStream), createWriteStream(u.path, { flags: o.part === 0 ? "w" : "a" }));
  u.bytes += n; u.next += 1; u.at = Date.now();
  if (!o.last) return null;
  u.summary = await inspectBackup(u.path, o.owner, u.bytes);
  return u.summary;
}

export function startRestore(id: string, owner: string): void {
  const u = uploads.get(id);
  if (!u || u.owner !== owner || !u.summary) throw new UploadError("expired");
  if (u.summary.blocked) throw new UploadError("expired");
  if ([...jobs.values()].some((j) => j.state === "running")) throw new UploadError("busy");
  const job: Job = { owner, state: "running", done: 0, total: 1 };
  jobs.set(id, job);
  void restoreBackup(u.path, owner, (d, t) => { job.done = d; job.total = t; })
    .then((r) => { job.state = "done"; job.createdAt = r.createdAt; })
    .catch((e) => { console.error("backup restore", e); job.state = "failed"; job.error = e instanceof BackupFormatError ? e.code : String((e as Error)?.message ?? e).slice(0, 200); })
    .finally(() => { uploads.delete(id); void rm(u.path, { force: true }); });
}

export function restoreState(id: string, owner: string): Job | null {
  const j = jobs.get(id);
  return j && j.owner === owner ? j : null;
}
