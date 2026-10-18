"use server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/session";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/i18n";

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export type FormState = { error?: string; ok?: boolean } | undefined;

export async function login(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  // gleiche Rechenzeit auch bei unbekannter E-Mail
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) return { error: "invalid" };
  const c = await cookies();
  c.set(SESSION_COOKIE, await signSession({ uid: user.id, name: user.name }), sessionCookieOptions);
  c.set(LOCALE_COOKIE, user.locale, { path: "/", maxAge: 60 * 60 * 24 * 365 });
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
  password: z.string().min(10),
  companyName: z.string().trim().min(2),
  vatId: z.string().trim().default(""),
  street: z.string().trim().default(""),
  zip: z.string().trim().default(""),
  city: z.string().trim().default(""),
});

export async function setup(_: FormState, fd: FormData): Promise<FormState> {
  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows;
  if (n > 0) return { error: "alreadyDone" };
  const parsed = SetupSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: "required" };
  const d = parsed.data;
  const hash = await bcrypt.hash(d.password, 12);
  const c = await cookies();
  const locale = (c.get(LOCALE_COOKIE)?.value as Locale) ?? "de";
  const [user] = await db.transaction(async (tx) => {
    await tx.insert(schema.companySettings).values({
      id: "company", name: d.companyName, owner: d.name, vatId: d.vatId, street: d.street, zip: d.zip, city: d.city,
    }).onConflictDoNothing();
    return tx.insert(schema.users).values({ name: d.name, email: d.email, passwordHash: hash, locale }).returning();
  });
  c.set(SESSION_COOKIE, await signSession({ uid: user.id, name: user.name }), sessionCookieOptions);
  redirect("/");
}
