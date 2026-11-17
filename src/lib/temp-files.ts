import "server-only";
/**
 * Abgelegte Dateien für den Assistenten und den Artikel-Import (Wunsch Inhaber 17.11.2026: Excel/PDF/Fotos in den Chat werfen).
 * Nur vorübergehend im Temp-Ordner des Servers, je Person getrennt, nach 6 Stunden weg – sie sind Arbeitsmaterial, keine Belege.
 * Was davon im System bleiben soll (Artikelfoto, Beleg einer Ausgabe …), speichert die jeweilige Seite wie immer selbst.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sheetKind } from "./sheet-read";

export type TempKind = "sheet" | "pdf" | "image";
export type TempMeta = { id: string; name: string; mime: string; size: number; kind: TempKind; at: number };
export const TEMP_MAX_BYTES = 20 * 1024 * 1024;
export const TEMP_MAX_FILES = 40;
const TTL = 6 * 3600_000;
const ROOT = path.join(tmpdir(), "star-style-temp");
const dirOf = (uid: string) => path.join(ROOT, uid.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "x");
export const validTempId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export class TempFileError extends Error {
  constructor(public code: "fileType" | "fileXls" | "fileTooLarge" | "empty") { super(code); }
}

/** Art der Datei an ihrem Inhalt erkennen (nicht am angegebenen Typ) */
export function detectKind(buf: Uint8Array, name: string): { kind: TempKind; mime: string } {
  const sk = sheetKind(buf, name);
  if (sk === "xls") throw new TempFileError("fileXls");
  if (sk === "xlsx") {
    if (!/\.(xlsx|xlsm)$/i.test(name)) throw new TempFileError("fileType"); // andere ZIPs (Word …) nicht
    return { kind: "sheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  }
  if (buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { kind: "pdf", mime: "application/pdf" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { kind: "image", mime: "image/png" };
  if (buf.length > 12 && String.fromCharCode(...buf.subarray(0, 4)) === "RIFF" && String.fromCharCode(...buf.subarray(8, 12)) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (buf.length > 6 && String.fromCharCode(...buf.subarray(0, 4)) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (sk === "csv") return { kind: "sheet", mime: "text/csv" };
  throw new TempFileError("fileType");
}

let lastSweep = 0;
async function sweep(now: number) {
  if (now - lastSweep < 10 * 60_000) return;
  lastSweep = now;
  const users = await readdir(ROOT).catch(() => [] as string[]);
  for (const u of users) {
    const dir = path.join(ROOT, u);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(path.join(dir, f)).catch(() => null);
      if (s && now - s.mtimeMs > TTL) await rm(path.join(dir, f), { force: true });
    }
  }
}

export async function saveTempFile(uid: string, name: string, buf: Uint8Array): Promise<TempMeta> {
  if (!buf.length) throw new TempFileError("empty");
  if (buf.length > TEMP_MAX_BYTES) throw new TempFileError("fileTooLarge");
  const { kind, mime } = detectKind(buf, name);
  const now = Date.now();
  await sweep(now).catch(() => {});
  const dir = dirOf(uid);
  await mkdir(dir, { recursive: true });
  // höchstens TEMP_MAX_FILES je Person: die ältesten gehen
  const metas = (await listTempFiles(uid)).sort((a, b) => a.at - b.at);
  for (const old of metas.slice(0, Math.max(0, metas.length - TEMP_MAX_FILES + 1))) await removeTempFile(uid, old.id);
  const meta: TempMeta = { id: randomUUID(), name: cleanName(name), mime, size: buf.length, kind, at: now };
  await writeFile(path.join(dir, `${meta.id}.bin`), buf);
  await writeFile(path.join(dir, `${meta.id}.json`), JSON.stringify(meta));
  return meta;
}

export async function loadTempFile(uid: string, id: string): Promise<{ meta: TempMeta; buf: Buffer } | null> {
  if (!validTempId(id)) return null;
  const dir = dirOf(uid);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, `${id}.json`), "utf8")) as TempMeta;
    if (meta.id !== id || Date.now() - meta.at > TTL) return null;
    return { meta, buf: await readFile(path.join(dir, `${id}.bin`)) };
  } catch { return null; }
}

export async function tempMeta(uid: string, id: string): Promise<TempMeta | null> {
  if (!validTempId(id)) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dirOf(uid), `${id}.json`), "utf8")) as TempMeta;
    return meta.id === id && Date.now() - meta.at <= TTL ? meta : null;
  } catch { return null; }
}

async function listTempFiles(uid: string): Promise<TempMeta[]> {
  const dir = dirOf(uid);
  const out: TempMeta[] = [];
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(await readFile(path.join(dir, f), "utf8")) as TempMeta); } catch { /* kaputt → egal */ }
  }
  return out;
}

async function removeTempFile(uid: string, id: string) {
  const dir = dirOf(uid);
  await rm(path.join(dir, `${id}.bin`), { force: true });
  await rm(path.join(dir, `${id}.json`), { force: true });
}

/** Dateiname ohne Pfad/Steuerzeichen, höchstens 120 Zeichen */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim().slice(0, 120) || "datei";
}

/** Body einer Anfrage lesen, höchstens `max` Bytes (sonst Fehler, ohne alles in den Speicher zu laden) */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); throw new TempFileError("fileTooLarge"); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
