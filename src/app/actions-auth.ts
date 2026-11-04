"use server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PENDING_COOKIE, SESSION_COOKIE, pendingCookieOptions, signPending, verifyPending } from "@/lib/session";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/i18n";
import {
  checkBlock, checkSecondFactor, codesExhausted, completeLogin, knownDevice, recordAttempt, requestCtx, trustedDevice,
} from "@/lib/login";
import { minutesLeft } from "@/lib/login-guard";

// gleiche Rechenzeit wie ein echtes Passwort (Kosten 12) → man erkennt nicht, ob es die E-Mail gibt
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

export type FormState = { error?: string; ok?: boolean; minutes?: number; step?: "code" } | undefined;

export async function login(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase().slice(0, 200);
  const password = String(fd.get("password") ?? "").slice(0, 500);
  const ctx = await requestCtx();
  const user = email ? await db.query.users.findFirst({ where: eq(schema.users.email, email) }) : undefined;
  const device = await knownDevice(user?.id);
  const block = await checkBlock({ email, device, ip: ctx.ip });
  if (block) {
    await recordAttempt({ userId: user?.id, email, ctx, device, step: "password", ok: false, reason: "locked" });
    return { error: "locked", minutes: minutesLeft(block, new Date()) };
  }
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    await recordAttempt({ userId: user?.id, email, ctx, device, step: "password", ok: false, reason: "invalid" });
    return { error: "invalid" };
  }
  // Zwei-Schritt eingeschaltet und Gerät nicht „vertraut“ → Code verlangen
  if (user.totpEnabledAt && user.totpSecret && !(await trustedDevice(user))) {
    await recordAttempt({ userId: user.id, email, ctx, device, step: "password", ok: true, reason: "needCode" });
    (await cookies()).set(PENDING_COOKIE, await signPending(user.id, user.sessionVersion), pendingCookieOptions);
    return { step: "code" };
  }
  await completeLogin(user, ctx, device, "password");
  redirect("/");
}

/** Zweiter Schritt: Code aus der App (oder Ersatz-Code) */
export async function verifyCode(_: FormState, fd: FormData): Promise<FormState> {
  const c = await cookies();
  const pending = await verifyPending(c.get(PENDING_COOKIE)?.value);
  if (!pending) return { error: "expired" };
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, pending.uid) });
  if (!user || user.sessionVersion !== pending.sv || !user.totpEnabledAt || !user.totpSecret) {
    c.delete(PENDING_COOKIE);
    return { error: "expired" };
  }
  const ctx = await requestCtx();
  const device = await knownDevice(user.id);
  const block = await checkBlock({ email: user.email, device, ip: ctx.ip });
  if (block) {
    c.delete(PENDING_COOKIE);
    await recordAttempt({ userId: user.id, email: user.email, ctx, device, step: "code", ok: false, reason: "locked" });
    return { error: "locked", minutes: minutesLeft(block, new Date()) };
  }
  if (await codesExhausted(user.id, pending.iat)) {
    c.delete(PENDING_COOKIE);
    return { error: "expired" };
  }
  const how = await checkSecondFactor(user, String(fd.get("code") ?? "").slice(0, 40));
  if (!how) {
    await recordAttempt({ userId: user.id, email: user.email, ctx, device, step: "code", ok: false, reason: "code" });
    return { error: "code", step: "code" };
  }
  c.delete(PENDING_COOKIE);
  await completeLogin(user, ctx, device, how, fd.get("remember") === "1");
  redirect("/");
}

export async function logout() {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function setLocale(locale: Locale) {
  if (!LOCALES.includes(locale)) return;
  const c = await cookies();
  c.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  const { getSession } = await import("@/lib/auth");
  const s = await getSession();
  if (s) await db.update(schema.users).set({ locale }).where(eq(schema.users.id, s.uid));
}

const SetupSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(72),
  companyName: z.string().trim().min(2),
  vatId: z.string().trim().default(""),
  street: z.string().trim().default(""),
  zip: z.string().trim().default(""),
  city: z.string().trim().default(""),
});

const userCount = async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows[0].n;

export async function setup(_: FormState, fd: FormData): Promise<FormState> {
  if ((await userCount()) > 0) return { error: "alreadyDone" };
  const parsed = SetupSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: "required" };
  const d = parsed.data;
  const hash = await bcrypt.hash(d.password, 12);
  const locale = ((await cookies()).get(LOCALE_COOKIE)?.value as Locale) ?? "de";
  // Sperre: zwei gleichzeitige Einrichtungen können nicht beide einen Benutzer anlegen
  const user = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(724501)`);
    const n = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows[0].n;
    if (n > 0) return null;
    await tx.insert(schema.companySettings).values({
      id: "company", name: d.companyName, owner: d.name, vatId: d.vatId, street: d.street, zip: d.zip, city: d.city,
    }).onConflictDoNothing();
    const [u] = await tx.insert(schema.users).values({ name: d.name, email: d.email, passwordHash: hash, locale, passwordChangedAt: new Date() }).returning();
    return u;
  });
  if (!user) return { error: "alreadyDone" };
  await completeLogin(user, await requestCtx(), "", "password");
  redirect("/");
}
