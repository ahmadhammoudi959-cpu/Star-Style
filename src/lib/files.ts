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
