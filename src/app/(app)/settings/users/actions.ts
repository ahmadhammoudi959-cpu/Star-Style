"use server";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/stock";
import { normalizePerms, tempPassword } from "@/lib/permissions";
import { forgetSession } from "@/lib/session-check";
import { LOCALES } from "@/i18n";

/**
 * Mitarbeiter verwalten (nur Admin, Wunsch Inhaber 12.11.2026). Kein Löschen (wie bei Kunden/Artikeln) – nur sperren.
 * Neue Mitarbeiter bekommen ein Einmal-Passwort (nur einmal in der Antwort, gespeichert nur als bcrypt-Hash);
 * beim ersten Anmelden müssen sie ein eigenes wählen (`must_change_password`, Middleware → /password).
 * Bewusst ohne revalidatePath (siehe CLAUDE.md „Hängender Übergang“): das Formular zeigt das Ergebnis selbst.
 */
export type UserValues = { name: string; email: string; locale: string; admin: boolean; perms: string[] };
export type UserResult = {
  ok?: boolean; error?: string; at?: number;
  id?: string; created?: boolean; password?: string; name?: string; email?: string;
  values?: UserValues;
};

const pgCode = (e: unknown) => (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
const newTemp = () => tempPassword((n) => new Uint8Array(randomBytes(n)));

function readPerms(raw: FormDataEntryValue | null): unknown {
  try { return JSON.parse(String(raw ?? "[]")); } catch { return []; }
}

export async function saveUserAction(_: UserResult | undefined, fd: FormData): Promise<UserResult> {
  const me = await requireAdmin();
  const id = String(fd.get("id") ?? "").slice(0, 64);
  const values: UserValues = {
    name: String(fd.get("name") ?? "").trim().slice(0, 100),
    email: String(fd.get("email") ?? "").trim().toLowerCase().slice(0, 200),
    locale: String(fd.get("locale") ?? "de"),
    admin: fd.get("admin") === "1",
    perms: normalizePerms(readPerms(fd.get("perms"))),
  };
  if (!(LOCALES as readonly string[]).includes(values.locale)) values.locale = "de";
  const fail = (error: string): UserResult => ({ error, values, at: Date.now() });

  const old = id ? await db.query.users.findFirst({ where: eq(schema.users.id, id) }) : undefined;
  if (id && !old) return fail("notFound");
  const self = !!old && old.id === me.uid;
  if (values.name.length < 2) return fail("required");
  if (!self) {
    if (!values.email) return fail("required");
    if (!z.email().safeParse(values.email).success) return fail("email");
    const taken = await db.query.users.findFirst({
      where: old ? and(eq(schema.users.email, values.email), ne(schema.users.id, old.id)) : eq(schema.users.email, values.email),
    });
    if (taken) return fail("emailTaken");
  }

  try {
    if (!old) {
      const password = newTemp();
      const passwordHash = await bcrypt.hash(password, 12);
      const [row] = await db.transaction(async (tx) => {
        const r = await tx.insert(schema.users).values({
          email: values.email, name: values.name, passwordHash, locale: values.locale,
          isAdmin: values.admin, permissions: values.admin ? [] : values.perms, mustChangePassword: true, createdBy: me.uid,
        }).returning();
        await audit(tx, {
          entity: "user", entityId: r[0].id, action: "create", userId: me.uid,
          after: { email: values.email, name: values.name, admin: values.admin, permissions: values.admin ? [] : values.perms, locale: values.locale },
        });
        return r;
      });
      return { ok: true, created: true, id: row.id, password, name: row.name, email: row.email, at: Date.now() };
    }

    // eigenes Konto: nur Name (und Sprache) – Admin bleibt man selbst immer (es muss immer einen geben), E-Mail/Passwort unter „Mein Konto“
    const next = self
      ? { name: values.name, locale: values.locale }
      : { name: values.name, email: values.email, locale: values.locale, isAdmin: values.admin, permissions: values.admin ? [] : values.perms };
    const before = { name: old.name, email: old.email, locale: old.locale, admin: old.isAdmin, permissions: old.permissions };
    await db.transaction(async (tx) => {
      await tx.update(schema.users).set(next).where(eq(schema.users.id, old.id));
      await audit(tx, { entity: "user", entityId: old.id, action: "update", before, after: next, userId: me.uid });
    });
    forgetSession(old.id); // neue Rechte gelten sofort
    return { ok: true, id: old.id, at: Date.now() };
  } catch (e) {
    if (pgCode(e) === "23505") return fail("emailTaken"); // gleichzeitig vergeben (eindeutiger Index)
    console.error("saveUser", e);
    return fail("error");
  }
}

/**
 * Neues Einmal-Passwort (Passwort vergessen, Handy weg): überall abmelden, Zwei-Schritt aus, beim Anmelden eigenes Passwort wählen.
 * Nicht für das eigene Konto (dafür „Mein Konto“).
 */
export async function resetPasswordAction(id: string): Promise<UserResult> {
  const me = await requireAdmin();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, String(id).slice(0, 64)) });
  if (!u) return { error: "notFound", at: Date.now() };
  if (u.id === me.uid) return { error: "self", at: Date.now() };
  const password = newTemp();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({
      passwordHash, mustChangePassword: true, passwordChangedAt: new Date(),
      totpSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [],
      sessionVersion: sql`${schema.users.sessionVersion} + 1`,
    }).where(eq(schema.users.id, u.id));
    await audit(tx, { entity: "user", entityId: u.id, action: "password-reset", before: { twoFactor: !!u.totpEnabledAt }, userId: me.uid });
  });
  forgetSession(u.id);
  return { ok: true, id: u.id, password, name: u.name, email: u.email, at: Date.now() };
}

/** Sperren (sofort überall abgemeldet, Anmeldung geht nicht mehr) bzw. wieder freischalten. Nicht das eigene Konto. */
export async function setActiveAction(id: string, active: boolean): Promise<UserResult> {
  const me = await requireAdmin();
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, String(id).slice(0, 64)) });
  if (!u) return { error: "notFound", at: Date.now() };
  if (u.id === me.uid) return { error: "self", at: Date.now() };
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set(active ? { active: true } : { active: false, sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .where(eq(schema.users.id, u.id));
    await audit(tx, { entity: "user", entityId: u.id, action: active ? "activate" : "deactivate", before: { active: u.active }, after: { active }, userId: me.uid });
  });
  forgetSession(u.id);
  return { ok: true, id: u.id, at: Date.now() };
}
