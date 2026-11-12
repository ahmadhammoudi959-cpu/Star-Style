import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession, type Session } from "./session";
import { loadAccess, type UserAccess } from "./session-check";
import type { Perm } from "./permissions";

export type Authed = Session & Pick<UserAccess, "admin" | "perms" | "mustChange">;

/** Sitzung + Rechte (einmal je Anfrage). Abgelaufen, abgemeldet oder Konto gesperrt → null */
export const getAuth = cache(async (): Promise<Authed | null> => {
  const c = await cookies();
  const s = await verifySession(c.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  const a = await loadAccess(s.uid, s.sv);
  if (!a || !a.active || a.sv !== s.sv) return null;
  return { ...s, name: a.name || s.name, admin: a.admin, perms: a.perms, mustChange: a.mustChange };
});

export async function getSession(): Promise<Session | null> {
  return getAuth();
}

/**
 * Angemeldet? Sonst zur Anmeldung. Mit Einmal-Passwort (vom Admin vergeben) erst ein eigenes Passwort setzen –
 * gilt auch für Server-Actions, die nicht durch die Middleware laufen.
 */
export async function requireAuth(o: { allowMustChange?: boolean } = {}): Promise<Authed> {
  const a = await getAuth();
  if (!a) redirect("/login");
  if (a.mustChange && !o.allowMustChange) redirect("/password");
  return a;
}

export async function requireSession(): Promise<Authed> {
  return requireAuth();
}

/** Eines der Rechte nötig (Server-Action/Seite). Ohne Recht → Startseite mit Hinweis „keine Berechtigung“ */
export async function requirePerm(...any: Perm[]): Promise<Authed> {
  const a = await requireAuth();
  if (!a.admin && !any.some((p) => a.perms.has(p))) redirect("/?denied=1");
  return a;
}

/** Nur Admin: Mitarbeiter verwalten, Testdaten zurücksetzen, Echtbetrieb */
export async function requireAdmin(): Promise<Authed> {
  const a = await requireAuth();
  if (!a.admin) redirect("/?denied=1");
  return a;
}

/** Für Seiten: darf der Angemeldete das? (Knöpfe/Felder zeigen oder nicht – geprüft wird trotzdem in der Action) */
export const can = (a: Pick<Authed, "admin" | "perms">, p: Perm) => a.admin || a.perms.has(p);

/**
 * API-Route: angemeldet und eines der Rechte (leer = nur angemeldet)? Sonst die passende Antwort 401/403.
 * Die Middleware prüft vorher dasselbe über `routeNeed` – das hier ist die zweite Sicherung direkt an der Route.
 */
export async function apiDenied(...any: Perm[]): Promise<Response | null> {
  const a = await getAuth();
  if (!a) return new Response("Unauthorized", { status: 401 });
  if (a.mustChange || (any.length && !a.admin && !any.some((p) => a.perms.has(p)))) return new Response("Forbidden", { status: 403 });
  return null;
}
