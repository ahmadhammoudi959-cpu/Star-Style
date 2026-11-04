import "server-only";
/**
 * Anmeldung: Protokoll aller Versuche, Sperre nach Fehlversuchen (Regeln rein in login-guard.ts),
 * Zwei-Schritt-Prüfung (totp.ts) und Ausgabe der Cookies (session.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { LOCALE_COOKIE } from "@/i18n";
import { decrypt } from "./crypto";
import { GUARD, clientIp, loginBlock, type Block, type FailCount } from "./login-guard";
import {
  DEVICE_COOKIE, SESSION_COOKIE, TRUST_COOKIE, deviceCookieOptions, sessionCookieOptions, signDevice, signSession, signTrust,
  trustCookieOptions, verifyDevice, verifyTrust,
} from "./session";
import { hashRecovery, looksLikeRecovery, verifyTotp } from "./totp";

export type User = typeof schema.users.$inferSelect;
export type Ctx = { ip: string; ua: string };
export type Step = "password" | "code" | "recovery" | "change";

export async function requestCtx(): Promise<Ctx> {
  const h = await headers();
  return { ip: clientIp(h), ua: (h.get("user-agent") ?? "").slice(0, 300) };
}

export async function recordAttempt(a: { userId?: string | null; email?: string; ctx: Ctx; device?: string; step: Step; ok: boolean; reason: string }) {
  // gesperrte Versuche höchstens einmal pro Minute und Absender aufschreiben (Angriffe sollen die Tabelle nicht füllen)
  if (a.reason === "locked") {
    const r = await db.execute(sql`select 1 from login_attempts where reason = 'locked' and ip = ${a.ctx.ip}
      and coalesce(user_id, '') = ${a.userId ?? ""} and at > now() - interval '1 minute' limit 1`);
    if (r.rows.length) return;
  }
  await db.insert(schema.loginAttempts).values({
    userId: a.userId ?? null, email: (a.email ?? "").slice(0, 200), ip: a.ctx.ip, userAgent: a.ctx.ua,
    device: a.device ?? "", step: a.step, ok: a.ok, reason: a.reason,
  });
}

const fc = (n: unknown, last: unknown): FailCount => ({ n: Number(n ?? 0), last: last ? new Date(String(last)) : null });

/** Sperre für diesen Versuch? (Konto = E-Mail – auch unbekannte E-Mails werden gleich behandelt, damit man nicht erkennt, welche es gibt –, bekanntes Gerät, IP, Notbremse) */
export async function checkBlock(o: { email: string; device: string; ip: string }): Promise<Block | null> {
  const r = (await db.execute<Record<string, unknown>>(sql`
    with acc_ok as (select coalesce(max(at), '-infinity'::timestamptz) as at from login_attempts
                    where email = ${o.email} and reason = 'success' and device = ''),
         dev_ok as (select coalesce(max(at), '-infinity'::timestamptz) as at from login_attempts
                    where ${o.device} <> '' and device = ${o.device} and reason = 'success')
    select
      count(*) filter (where a.email = ${o.email} and a.device = '' and a.at > (select at from acc_ok))::int as acc_n,
      max(a.at) filter (where a.email = ${o.email} and a.device = '' and a.at > (select at from acc_ok)) as acc_last,
      count(*) filter (where ${o.device} <> '' and a.device = ${o.device} and a.at > now() - interval '15 minutes' and a.at > (select at from dev_ok))::int as dev_n,
      max(a.at) filter (where ${o.device} <> '' and a.device = ${o.device} and a.at > now() - interval '15 minutes' and a.at > (select at from dev_ok)) as dev_last,
      count(*) filter (where a.ip = ${o.ip} and a.device = '' and a.at > now() - interval '60 minutes')::int as ip_n,
      max(a.at) filter (where a.ip = ${o.ip} and a.device = '' and a.at > now() - interval '60 minutes') as ip_last,
      count(*) filter (where a.device = '' and a.at > now() - interval '10 minutes')::int as all_n,
      max(a.at) filter (where a.device = '' and a.at > now() - interval '10 minutes') as all_last
    from login_attempts a
    where a.reason in ('invalid', 'code') and a.at > now() - interval '24 hours'`)).rows[0] ?? {};
  return loginBlock({
    now: new Date(), trusted: o.device !== "",
    account: fc(r.acc_n, r.acc_last), device: fc(r.dev_n, r.dev_last), ip: fc(r.ip_n, r.ip_last), global: fc(r.all_n, r.all_last),
  });
}

/** Falsche Codes seit dem richtigen Passwort (iat = Sekunden) */
export async function codeFailuresSince(userId: string, iat: number): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from login_attempts
    where user_id = ${userId} and reason = 'code' and at >= to_timestamp(${iat})`);
  return Number(r.rows[0]?.n ?? 0);
}
export const codesExhausted = async (userId: string, iat: number) => (await codeFailuresSince(userId, iat)) >= GUARD.codesPerLogin;

/** Geräte-ID, wenn dieses Gerät für das Konto bekannt ist (sonst leer) */
export async function knownDevice(userId: string | null | undefined): Promise<string> {
  if (!userId) return "";
  const d = await verifyDevice((await cookies()).get(DEVICE_COOKIE)?.value);
  return d && d.uid === userId ? d.d : "";
}

/** „Diesem Gerät vertrauen“ gültig? (nur bis zur nächsten Sitzungs-Version) */
export async function trustedDevice(user: User): Promise<boolean> {
  const t = await verifyTrust((await cookies()).get(TRUST_COOKIE)?.value);
  return !!t && t.uid === user.id && t.sv === user.sessionVersion;
}

/** Schlüssel für die HMAC der Ersatz-Codes */
export const recoveryPepper = () => createHash("sha256").update(`star-style/recovery/${process.env.SESSION_SECRET ?? ""}`).digest("hex");

/** Zweiter Schritt: 6-stelliger Code aus der App oder ein Ersatz-Code. Atomar – kein Code geht zweimal. */
export async function checkSecondFactor(user: User, input: string, allowRecovery = true): Promise<"code" | "recovery" | null> {
  if (!user.totpSecret) return null;
  const code = input.trim();
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    const step = verifyTotp(decrypt(user.totpSecret), code, Date.now(), user.totpLastStep);
    if (step == null) return null;
    const r = await db.execute(sql`update users set totp_last_step = ${step}
      where id = ${user.id} and (totp_last_step is null or totp_last_step < ${step}) returning id`);
    return r.rows.length ? "code" : null;
  }
  if (allowRecovery && looksLikeRecovery(code)) {
    const h = hashRecovery(code, recoveryPepper());
    const r = await db.execute(sql`update users set recovery_codes = recovery_codes - ${h}::text
      where id = ${user.id} and recovery_codes ? ${h}::text returning id`);
    return r.rows.length ? "recovery" : null;
  }
  return null;
}

/** Sitzungs-Cookie (und auf Wunsch „Gerät vertrauen“) für die aktuelle Sitzungs-Version ausstellen */
export async function startSession(user: User, o: { trust?: boolean } = {}) {
  const c = await cookies();
  c.set(SESSION_COOKIE, await signSession({ uid: user.id, name: user.name, sv: user.sessionVersion }), sessionCookieOptions);
  if (o.trust) c.set(TRUST_COOKIE, await signTrust(user.id, user.sessionVersion), trustCookieOptions);
}

/** Anmeldung abschließen: protokollieren, Gerät merken, Sitzung starten */
export async function completeLogin(user: User, ctx: Ctx, device: string, step: Step, trust = false) {
  await recordAttempt({ userId: user.id, email: user.email, ctx, device, step, ok: true, reason: "success" });
  const c = await cookies();
  c.set(DEVICE_COOKIE, await signDevice(user.id, device || randomBytes(16).toString("hex")), deviceCookieOptions);
  await startSession(user, { trust });
  c.set(LOCALE_COOKIE, user.locale, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  await db.execute(sql`delete from login_attempts where at < now() - interval '90 days'`);
}

export type AttemptRow = { at: string; ok: boolean; reason: string; step: string; ip: string; userAgent: string; email: string };

export async function recentAttempts(limit = 15): Promise<AttemptRow[]> {
  const r = await db.execute<{ at: string; ok: boolean; reason: string; step: string; ip: string; user_agent: string; email: string }>(sql`
    select at, ok, reason, step, ip, user_agent, email from login_attempts order by at desc limit ${limit}`);
  return r.rows.map((x) => ({ at: new Date(x.at).toISOString(), ok: x.ok, reason: x.reason, step: x.step, ip: x.ip, userAgent: x.user_agent, email: x.email }));
}

/** Fehlversuche seit der vorletzten Anmeldung (also auch während der jetzigen Sitzung) – für den Hinweis auf der Startseite */
export async function failuresSincePrevious(): Promise<{ n: number; last: string | null }> {
  const r = await db.execute<{ n: number; last: string | null }>(sql`
    with s as (select at from login_attempts where reason = 'success' order by at desc limit 2),
         since as (select case when (select count(*) from s) = 2 then (select min(at) from s) else '-infinity'::timestamptz end as at)
    select count(*)::int as n, max(at) as last from login_attempts
    where reason in ('invalid', 'code', 'locked') and at > (select at from since) and at > now() - interval '30 days'`);
  const row = r.rows[0];
  return { n: Number(row?.n ?? 0), last: row?.last ? new Date(row.last).toISOString() : null };
}

/** Datenbank über die interne Adresse von Render verbunden? (Werte bleiben geheim, nur ja/nein) */
export function dbConnectionInternal(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return !host.includes(".");
  } catch {
    return false;
  }
}
