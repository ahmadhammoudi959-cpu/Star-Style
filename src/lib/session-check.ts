/**
 * Ist eine Sitzung noch gültig, und was darf der Benutzer? Eine Abfrage liefert Sitzungs-Version, „aktiv“, Admin, Rechte und
 * „muss Passwort ändern“ (Passwort geändert / „alle Geräte abmelden“ / Konto gesperrt → alte Cookies sofort wertlos;
 * geänderte Rechte gelten sofort im selben Prozess, sonst nach höchstens 5 s).
 * Läuft auch in der Middleware (Node) – darum kein "server-only".
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { effectivePerms, type Perm } from "./permissions";

export type UserAccess = { uid: string; sv: number; name: string; active: boolean; admin: boolean; perms: Set<Perm>; mustChange: boolean };

const TTL_MS = 5_000;
// Ein Zwischenspeicher für den ganzen Prozess (globalThis): Next.js lädt dieses Modul mehrfach – für Seiten, für Server-Actions
// und für die Middleware. Mit je eigenem Speicher wirkte forgetSession() aus der Action „Sperren“ nicht auf Seiten und Middleware
// (12.11.2026 im Test: gesperrter Mitarbeiter noch bis zu 5 s drin, entzogenes Recht noch sichtbar).
const g = globalThis as typeof globalThis & { __ssAccessCache?: Map<string, { a: UserAccess; at: number }> };
const cache = (g.__ssAccessCache ??= new Map());

/**
 * sv = Sitzungs-Version aus dem Cookie: der Zwischenspeicher gilt nur, wenn sie dazu passt – ein frisch ausgestelltes Cookie
 * (neues Passwort, erstes eigenes Passwort) liest also sofort neu, statt an einer alten Zahl zu scheitern
 * (Middleware und App haben getrennte Zwischenspeicher, forgetSession wirkt nur im eigenen).
 */
export async function loadAccess(uid: string, sv?: number): Promise<UserAccess | null> {
  const c = cache.get(uid);
  if (c && Date.now() - c.at < TTL_MS && (sv === undefined || c.a.sv === sv)) return c.a;
  try {
    const r = await db.execute<{ sv: number; name: string; active: boolean; is_admin: boolean; permissions: unknown; must_change_password: boolean }>(sql`
      select session_version as sv, name, active, is_admin, permissions, must_change_password from users where id = ${uid}`);
    const row = r.rows[0];
    if (!row) { cache.delete(uid); return null; }
    const a: UserAccess = {
      uid, sv: Number(row.sv), name: row.name, active: row.active, admin: row.is_admin,
      perms: effectivePerms(row.permissions, row.is_admin), mustChange: row.must_change_password,
    };
    cache.set(uid, { a, at: Date.now() });
    return a;
  } catch {
    return null; // im Zweifel nicht hereinlassen
  }
}

/** Cookie passt zur Datenbank und das Konto ist aktiv? */
export async function sessionCurrent(uid: string, sv: number): Promise<boolean> {
  const a = await loadAccess(uid, sv);
  return !!a && a.active && a.sv === sv;
}

/** Nach einer Änderung im selben Prozess sofort neu lesen */
export const forgetSession = (uid: string) => cache.delete(uid);
/** Nach dem Zurückholen einer Datensicherung: alle neu lesen */
export const forgetAllSessions = () => cache.clear();
