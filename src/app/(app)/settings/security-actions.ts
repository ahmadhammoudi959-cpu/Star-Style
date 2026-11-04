"use server";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { decrypt, encrypt } from "@/lib/crypto";
import { audit } from "@/lib/stock";
import {
  checkBlock, checkSecondFactor, knownDevice, recordAttempt, recoveryPepper, requestCtx, startSession, trustedDevice, type User,
} from "@/lib/login";
import { minutesLeft } from "@/lib/login-guard";
import { forgetSession } from "@/lib/session-check";
import { groupSecret, hashRecovery, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import { qrSvgPath } from "@/lib/qr";

export type SecResult = {
  ok?: boolean; error?: string; minutes?: number;
  secret?: string; uri?: string; qr?: { size: number; d: string }; codes?: string[];
};

async function me(): Promise<User> {
  const s = await requireSession();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, s.uid) });
  if (!u) throw new Error("user");
  return u;
}

/** Vor Passwort-/Code-Prüfungen: dieselbe Sperre wie bei der Anmeldung (gegen Durchprobieren mit gestohlener Sitzung) */
async function guard(u: User) {
  const ctx = await requestCtx();
  const device = await knownDevice(u.id);
  const block = await checkBlock({ email: u.email, device, ip: ctx.ip });
  const fail = (reason: "invalid" | "code") => recordAttempt({ userId: u.id, email: u.email, ctx, device, step: "change", ok: false, reason });
  return { ctx, device, block, fail };
}
const locked = (b: NonNullable<Awaited<ReturnType<typeof guard>>["block"]>): SecResult => ({ error: "locked", minutes: minutesLeft(b, new Date()) });

/** Neue Sitzungs-Version: alle anderen Geräte abgemeldet; dieses Gerät bekommt sofort ein neues Cookie */
async function bumpSessions(u: User, action: string, set: Partial<typeof schema.users.$inferInsert> = {}) {
  const keepTrust = await trustedDevice(u);
  const [nu] = await db.transaction(async (tx) => {
    const r = await tx.update(schema.users).set({ ...set, sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .where(eq(schema.users.id, u.id)).returning();
    await audit(tx, { entity: "user", entityId: u.id, action, userId: u.id });
    return r;
  });
  forgetSession(u.id);
  await startSession(nu, { trust: keepTrust });
  return nu;
}

// ── Zwei-Schritt-Anmeldung ──

/** Schritt 1: Schlüssel erzeugen und als QR-Code zeigen (noch aus, bis der erste Code stimmt) */
export async function startTwoFactorAction(): Promise<SecResult> {
  const u = await me();
  if (u.totpEnabledAt) return { error: "already" };
  const secret = newTotpSecret();
  await db.update(schema.users).set({ totpSecret: encrypt(secret), totpLastStep: null }).where(eq(schema.users.id, u.id));
  const uri = otpauthUri(secret, u.email);
  return { secret: groupSecret(secret), uri, qr: qrSvgPath(uri) };
}

export async function cancelTwoFactorAction(): Promise<SecResult> {
  const u = await me();
  if (!u.totpEnabledAt) await db.update(schema.users).set({ totpSecret: null, totpLastStep: null }).where(eq(schema.users.id, u.id));
  return { ok: true };
}

/** Schritt 2: erster Code stimmt → einschalten, Ersatz-Codes einmal zeigen, alle anderen Geräte abmelden */
export async function confirmTwoFactorAction(_: SecResult | undefined, fd: FormData): Promise<SecResult> {
  const u = await me();
  if (u.totpEnabledAt) return { error: "already" };
  if (!u.totpSecret) return { error: "notPending" };
  const g = await guard(u);
  if (g.block) return locked(g.block);
  const step = verifyTotp(decrypt(u.totpSecret), String(fd.get("code") ?? ""), Date.now(), null);
  if (step == null) { await g.fail("code"); return { error: "code" }; }
  const codes = newRecoveryCodes();
  const pepper = recoveryPepper();
  await bumpSessions(u, "2fa-on", { totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: codes.map((c) => hashRecovery(c, pepper)) });
  return { ok: true, codes };
}

/** Ausschalten: Passwort + Code (oder Ersatz-Code) */
export async function disableTwoFactorAction(_: SecResult | undefined, fd: FormData): Promise<SecResult> {
  const u = await me();
  if (!u.totpEnabledAt) return { ok: true };
  const g = await guard(u);
  if (g.block) return locked(g.block);
  if (!(await bcrypt.compare(String(fd.get("password") ?? "").slice(0, 500), u.passwordHash))) { await g.fail("invalid"); return { error: "password" }; }
  if (!(await checkSecondFactor(u, String(fd.get("code") ?? "").slice(0, 40)))) { await g.fail("code"); return { error: "code" }; }
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] }).where(eq(schema.users.id, u.id));
    await audit(tx, { entity: "user", entityId: u.id, action: "2fa-off", userId: u.id });
  });
  return { ok: true };
}

/** Neue Ersatz-Codes (die alten gelten nicht mehr) – nur mit Code aus der App */
export async function newRecoveryCodesAction(_: SecResult | undefined, fd: FormData): Promise<SecResult> {
  const u = await me();
  if (!u.totpEnabledAt || !u.totpSecret) return { error: "notOn" };
  const g = await guard(u);
  if (g.block) return locked(g.block);
  if ((await checkSecondFactor(u, String(fd.get("code") ?? "").slice(0, 40), false)) !== "code") { await g.fail("code"); return { error: "code" }; }
  const codes = newRecoveryCodes();
  const pepper = recoveryPepper();
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ recoveryCodes: codes.map((c) => hashRecovery(c, pepper)) }).where(eq(schema.users.id, u.id));
    await audit(tx, { entity: "user", entityId: u.id, action: "recovery-codes", userId: u.id });
  });
  return { ok: true, codes };
}

// ── Passwort & Geräte ──

export async function changePasswordAction(_: SecResult | undefined, fd: FormData): Promise<SecResult> {
  const u = await me();
  const current = String(fd.get("current") ?? "").slice(0, 500);
  const next = String(fd.get("next") ?? "");
  const repeat = String(fd.get("repeat") ?? "");
  const g = await guard(u);
  if (g.block) return locked(g.block);
  if (!(await bcrypt.compare(current, u.passwordHash))) { await g.fail("invalid"); return { error: "password" }; }
  if (next.length < 10) return { error: "short" };
  if (Buffer.byteLength(next, "utf8") > 72) return { error: "long" }; // bcrypt liest nur 72 Bytes
  if (next !== repeat) return { error: "mismatch" };
  if (next === current) return { error: "same" };
  const passwordHash = await bcrypt.hash(next, 12);
  await bumpSessions(u, "password", { passwordHash, passwordChangedAt: new Date() });
  await recordAttempt({ userId: u.id, email: u.email, ctx: g.ctx, device: g.device, step: "change", ok: true, reason: "changed" });
  return { ok: true };
}

export async function logoutOthersAction(): Promise<SecResult> {
  const u = await me();
  await bumpSessions(u, "logout-all");
  return { ok: true };
}
