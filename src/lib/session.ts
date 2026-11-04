import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * Signierte Cookies (HS256 mit SESSION_SECRET). Jede Art hat ein eigenes „typ“, damit kein Cookie als anderes durchgeht.
 * - Sitzung (12 h): uid, name, sv = Sitzungs-Version des Benutzers (Middleware vergleicht mit der Datenbank → abmeldbar)
 * - Zwei-Schritt offen (5 min): nach richtigem Passwort, bis der Code eingegeben ist
 * - Gerät vertrauen (30 Tage): kein Code nötig, gilt nur bis zur nächsten Sitzungs-Version
 * - Bekanntes Gerät (1 Jahr): nur für die Sperre nach Fehlversuchen (login-guard.ts)
 */
export const SESSION_COOKIE = "ss_session";
export const PENDING_COOKIE = "ss_2fa";
export const TRUST_COOKIE = "ss_trust";
export const DEVICE_COOKIE = "ss_dev";

const MAX_AGE = 60 * 60 * 12; // 12 Stunden
const PENDING_AGE = 60 * 5;
const TRUST_AGE = 60 * 60 * 24 * 30;
const DEVICE_AGE = 60 * 60 * 24 * 365;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen");
  return new TextEncoder().encode(s);
}

async function sign(payload: JWTPayload, seconds: number) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${seconds}s`).sign(key());
}
async function read(token: string | undefined, typ: string): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.typ === typ ? payload : null;
  } catch {
    return null;
  }
}

export type Session = { uid: string; name: string; sv: number };

export const signSession = (s: Session) => sign({ typ: "s", uid: s.uid, name: s.name, sv: s.sv }, MAX_AGE);

export async function verifySession(token: string | undefined): Promise<Session | null> {
  const p = await read(token, "s");
  if (!p || typeof p.uid !== "string" || typeof p.sv !== "number") return null;
  return { uid: p.uid, name: String(p.name ?? ""), sv: p.sv };
}

export type Pending = { uid: string; sv: number; iat: number };
export const signPending = (uid: string, sv: number) => sign({ typ: "2fa", uid, sv }, PENDING_AGE);
export async function verifyPending(token: string | undefined): Promise<Pending | null> {
  const p = await read(token, "2fa");
  if (!p || typeof p.uid !== "string" || typeof p.sv !== "number" || typeof p.iat !== "number") return null;
  return { uid: p.uid, sv: p.sv, iat: p.iat };
}

export const signTrust = (uid: string, sv: number) => sign({ typ: "trust", uid, sv }, TRUST_AGE);
export async function verifyTrust(token: string | undefined): Promise<{ uid: string; sv: number } | null> {
  const p = await read(token, "trust");
  return p && typeof p.uid === "string" && typeof p.sv === "number" ? { uid: p.uid, sv: p.sv } : null;
}

export const signDevice = (uid: string, d: string) => sign({ typ: "dev", uid, d }, DEVICE_AGE);
export async function verifyDevice(token: string | undefined): Promise<{ uid: string; d: string } | null> {
  const p = await read(token, "dev");
  return p && typeof p.uid === "string" && typeof p.d === "string" ? { uid: p.uid, d: p.d } : null;
}

const base = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
export const sessionCookieOptions = { ...base, maxAge: MAX_AGE };
export const pendingCookieOptions = { ...base, sameSite: "strict" as const, maxAge: PENDING_AGE };
export const trustCookieOptions = { ...base, maxAge: TRUST_AGE };
export const deviceCookieOptions = { ...base, maxAge: DEVICE_AGE };
