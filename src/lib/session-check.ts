/**
 * Ist eine Sitzung noch gültig? Vergleicht die Sitzungs-Version im Cookie mit der Datenbank
 * (Passwort geändert / „alle Geräte abmelden“ → alte Cookies sind sofort wertlos).
 * Läuft auch in der Middleware (Node) – darum kein "server-only". Kurzer Zwischenspeicher: höchstens 5 s alt.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

const TTL_MS = 5_000;
const cache = new Map<string, { sv: number; at: number }>();

export async function sessionCurrent(uid: string, sv: number): Promise<boolean> {
  const c = cache.get(uid);
  if (c && c.sv === sv && Date.now() - c.at < TTL_MS) return true;
  try {
    const r = await db.execute<{ sv: number }>(sql`select session_version as sv from users where id = ${uid}`);
    const cur = r.rows[0]?.sv;
    if (cur == null) { cache.delete(uid); return false; }
    cache.set(uid, { sv: Number(cur), at: Date.now() });
    return Number(cur) === sv;
  } catch {
    return false; // im Zweifel nicht hereinlassen
  }
}

/** Nach einer Änderung im selben Prozess sofort neu lesen */
export const forgetSession = (uid: string) => cache.delete(uid);
