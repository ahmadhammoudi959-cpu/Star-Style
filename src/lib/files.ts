import "server-only";
import { createHash } from "node:crypto";
import { db, schema } from "@/db";

const MAX = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export async function storeUpload(file: File | null): Promise<string | null> {
  if (!file || file.size === 0) return null;
  if (file.size > MAX) throw new Error("fileTooLarge");
  if (!ALLOWED.includes(file.type)) throw new Error("fileType");
  const buf = Buffer.from(await file.arrayBuffer());
  const [row] = await db.insert(schema.storedFiles).values({
    name: file.name.slice(0, 200), mime: file.type, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
  }).returning({ id: schema.storedFiles.id });
  return row.id;
}

/** Nur echte Bilder (Signatur geprüft, nicht nur der angegebene Typ) – für Artikelfotos */
function imageMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** Foto aus einer bekannten Quelle (z. B. Shopify-CDN beim Produkt-Import) speichern – gleiche Prüfung wie beim Hochladen */
export async function storeImageBytes(buf: Buffer, name: string): Promise<string> {
  if (buf.length === 0 || buf.length > MAX) throw new Error("fileTooLarge");
  const mime = imageMime(buf);
  if (!mime) throw new Error("imageType");
  const [row] = await db.insert(schema.storedFiles).values({
    name: (name || "foto").slice(0, 200), mime, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
  }).returning({ id: schema.storedFiles.id });
  return row.id;
}

export async function storeImage(file: File | null): Promise<string | null> {
  if (!file || typeof file === "string" || file.size === 0) return null;
  if (file.size > MAX) throw new Error("fileTooLarge");
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = imageMime(buf);
  if (!mime) throw new Error("imageType");
  const [row] = await db.insert(schema.storedFiles).values({
    name: (file.name || "foto").slice(0, 200), mime, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
  }).returning({ id: schema.storedFiles.id });
  return row.id;
}
