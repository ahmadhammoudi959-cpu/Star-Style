import "server-only";
/** Geheimnisse (z. B. Shopify-Zugangsdaten) verschlüsselt in der Datenbank ablegen – AES-256-GCM. */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

let cached: Buffer | null = null;
function key() {
  if (cached) return cached;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET fehlt");
  cached = scryptSync(secret, "star-style/secrets/v1", 32);
  return cached;
}

export function encrypt(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(enc: string): string {
  if (!enc) return "";
  const [v, iv, tag, data] = enc.split(".");
  if (v !== "v1") throw new Error("unknown format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
