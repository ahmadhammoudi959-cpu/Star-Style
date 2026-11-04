/**
 * Zwei-Schritt-Anmeldung (TOTP, RFC 6238) – rein, ohne fremde Pakete, getestet mit den Werten aus dem RFC.
 * Passt zu Google Authenticator, Microsoft Authenticator, 1Password usw.: SHA-1, 6 Ziffern, 30 Sekunden.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xfff; // nie mehr als 12 offene Bits
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32");
    value = ((value << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (ms: number) => Math.floor(ms / 1000 / TOTP_PERIOD);
export const totpCode = (secret: string, ms: number, digits = 6) => hotp(base32Decode(secret), totpStep(ms), digits);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Prüft einen 6-stelligen Code. Erlaubt ein Fenster davor/danach (Handy-Uhr geht etwas falsch).
 * Ergebnis = benutztes Zeitfenster, aber nur wenn es neuer ist als lastStep → derselbe Code geht nicht zweimal.
 */
export function verifyTotp(secret: string, code: string, ms: number, lastStep: number | null): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret);
  const now = totpStep(ms);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    if (same(hotp(key, step), c)) return step;
  }
  return null;
}

/** 160 Bit Zufall, wie vom RFC empfohlen */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function otpauthUri(secret: string, account: string, issuer = "Star Style"): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}

/** Schlüssel zum Abtippen in Vierergruppen */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

// ── Ersatz-Codes (wenn das Handy weg ist): 10 Stück, je einmal gültig, gespeichert nur als HMAC ──
const RC = "23456789abcdefghjkmnpqrstuvwxyz"; // ohne 0/o, 1/l/i – gut abzuschreiben
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = Array.from({ length: 10 }, () => RC[randomInt(RC.length)]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normalizeRecovery = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const looksLikeRecovery = (s: string) => /^[a-z0-9]{10}$/.test(normalizeRecovery(s));
export const hashRecovery = (code: string, pepper: string) => createHmac("sha256", pepper).update(normalizeRecovery(code)).digest("hex");
