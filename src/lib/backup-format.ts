/**
 * Datensicherung – Dateiformat (rein, ohne Datenbank; getestet in tests/backup.test.ts).
 *
 * Datei = "SSBK" + Version (1 Byte) + IV (12 Byte) + AES-256-GCM(gzip(Zeilen)) + Prüfwert (16 Byte).
 * Schlüssel aus SESSION_SECRET (HKDF): nur dieses System kann die Datei öffnen – ein verlorener Laptop gibt keine Kundendaten preis.
 * Zeilen (NDJSON): 1. Manifest, dann je Tabelle eine Kopfzeile {"$table","columns"} und die Zeilen als JSON (row_to_json),
 * am Ende {"$end":true}. Spaltennamen sind snake_case – eine Datenzeile beginnt darum nie mit "$".
 * Der Prüfwert steht am Ende: erst wenn er stimmt, darf das Zurückholen gültig werden (Transaktion erst danach bestätigen).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

export const MAGIC = Buffer.from("SSBK");
export const FORMAT = 1;
export const HEADER_LEN = MAGIC.length + 1 + 12;
export const TAG_LEN = 16;
export const FILE_EXT = ".ssbak";

export type Manifest = {
  kind: "star-style-backup"; format: number; createdAt: string; createdBy: string;
  migrations: number; live: boolean;
  tables: { name: string; rows: number }[];
  sequences: Record<string, { value: number; called: boolean }>;
};

export function backupKey(secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET fehlt");
  return Buffer.from(hkdfSync("sha256", secret, "star-style/backup", "file-key-v1", 32));
}

/** Verschlüsselt alles, was hineingeschrieben wird; vorne der Kopf, hinten der Prüfwert */
export function encryptStream(key: Buffer): Transform {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) { this.push(Buffer.concat([MAGIC, Buffer.from([FORMAT]), iv])); headerSent = true; }
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, Buffer.from([FORMAT]), iv]));
      const last = cipher.final();
      cb(null, Buffer.concat([last, cipher.getAuthTag()]));
    },
  });
}

export const TABLE_PREFIX = '{"$table":';
export const END_LINE = '{"$end":true}';
export const tableLine = (name: string, columns: string[]) => JSON.stringify({ $table: name, columns });

export class BackupFormatError extends Error {
  constructor(public code: "invalid" | "newer" | "noAdmin" | "tooBig" | "empty") { super(code); }
}

/**
 * Liest eine Sicherungsdatei Zeile für Zeile (entschlüsselt + entpackt). Wirft am Ende BackupFormatError("invalid"),
 * wenn der Prüfwert nicht stimmt (falscher Schlüssel = anderes System, oder beschädigt/verändert).
 * Wichtig: Die Zeilen kommen VOR der Prüfung – Änderungen erst nach dem Ende von `readLines` bestätigen.
 */
export async function readLines(path: string, key: Buffer, onLine: (line: string) => Promise<void> | void): Promise<void> {
  const fh = await open(path, "r");
  let size: number;
  const header = Buffer.alloc(HEADER_LEN), tag = Buffer.alloc(TAG_LEN);
  try {
    size = (await fh.stat()).size;
    if (size < HEADER_LEN + TAG_LEN) throw new BackupFormatError("invalid");
    await fh.read(header, 0, HEADER_LEN, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { await fh.close(); }
  if (!header.subarray(0, 4).equals(MAGIC)) throw new BackupFormatError("invalid");
  if (header[4] !== FORMAT) throw new BackupFormatError(header[4] > FORMAT ? "newer" : "invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(5, HEADER_LEN));
  decipher.setAuthTag(tag);
  // Fehler aus onLine (z. B. Datenbank) gehen unverändert weiter; alles andere (Prüfwert, gzip, abgeschnitten) = „keine gültige Sicherung“
  let own: unknown = null;
  try {
    await pipeline(createReadStream(path, { start: HEADER_LEN, end: size - TAG_LEN - 1 }), decipher, createGunzip(), async (src: AsyncIterable<Buffer>) => {
      const dec = new StringDecoder("utf8");
      let buf = "";
      const emit = async (line: string) => { try { await onLine(line); } catch (e) { own = e; throw e; } };
      for await (const chunk of src) {
        buf += dec.write(chunk);
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) await emit(line);
        }
      }
      buf += dec.end();
      if (buf) await emit(buf);
    });
  } catch (e) {
    if (own) throw own;
    throw new BackupFormatError("invalid");
  }
}

/**
 * Zwei Zeilen (row_to_json) gleich? Verglichen werden nur Spalten, die es in beiden gibt (eine Spalte, die ein Programm-Update
 * später dazugebracht hat, zählt nicht); Zeitstempel nach dem Zeitpunkt, nicht nach der Schreibweise (+00:00 / Z).
 */
export function sameRow(a: string, b: string): boolean {
  const x = JSON.parse(a) as Record<string, unknown>, y = JSON.parse(b) as Record<string, unknown>;
  for (const k of Object.keys(x)) if (k in y && !sameValue(x[k], y[k])) return false;
  return true;
}
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string" && a !== b && TS.test(a) && TS.test(b)) return Date.parse(a) === Date.parse(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Tabellen so ordnen, dass jede nach den Tabellen kommt, auf die sie verweist (Fremdschlüssel). Gleichrangig: nach Name. */
export function tableOrder(tables: string[], fks: { from: string; to: string }[]): string[] {
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const f of fks) if (set.has(f.from) && set.has(f.to) && f.from !== f.to) deps.get(f.from)!.add(f.to);
  const out: string[] = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...deps.get(t)!].every((d) => !left.has(d))).sort();
    if (!ready.length) throw new Error(`Fremdschlüssel im Kreis: ${[...left].join(", ")}`);
    for (const t of ready) { out.push(t); left.delete(t); }
  }
  return out;
}

/** Nur einfache Bezeichner aus dem Katalog (keine Nutzereingaben) – trotzdem prüfen und sicher quoten */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Ungültiger Bezeichner: ${name}`);
  return `"${name}"`;
}

/** Dateiname zum Herunterladen, z. B. StarStyle-Sicherung-2026-11-12_2355.ssbak (deutsche Zeit) */
export function backupFileName(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `StarStyle-Sicherung-${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${FILE_EXT}`;
}
