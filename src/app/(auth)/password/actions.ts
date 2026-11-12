"use server";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth";
import { audit } from "@/lib/stock";
import { knownDevice, recordAttempt, requestCtx, startSession } from "@/lib/login";
import { forgetSession } from "@/lib/session-check";

export type FirstPasswordResult = { error?: string; at?: number };

/**
 * Erstes eigenes Passwort nach dem Einmal-Passwort vom Admin (Pflicht, vorher ist alles andere zu).
 * Danach neue Sitzungs-Version (das Einmal-Passwort und alte Cookies gelten nicht mehr) und weiter zur Startseite.
 */
export async function setFirstPasswordAction(_: FirstPasswordResult | undefined, fd: FormData): Promise<FirstPasswordResult> {
  const a = await requireAuth({ allowMustChange: true });
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, a.uid) });
  if (!u) redirect("/login");
  if (!u.mustChangePassword) redirect("/");
  const next = String(fd.get("next") ?? "");
  const repeat = String(fd.get("repeat") ?? "");
  const fail = (error: string) => ({ error, at: Date.now() });
  if (next.length < 10) return fail("short");
  if (Buffer.byteLength(next, "utf8") > 72) return fail("long"); // bcrypt liest nur 72 Bytes
  if (next !== repeat) return fail("mismatch");
  if (await bcrypt.compare(next, u.passwordHash)) return fail("same");
  const passwordHash = await bcrypt.hash(next, 12);
  const [nu] = await db.transaction(async (tx) => {
    const r = await tx.update(schema.users)
      .set({ passwordHash, passwordChangedAt: new Date(), mustChangePassword: false, sessionVersion: sql`${schema.users.sessionVersion} + 1` })
      .where(eq(schema.users.id, u.id)).returning();
    await audit(tx, { entity: "user", entityId: u.id, action: "password-first", userId: u.id });
    return r;
  });
  forgetSession(u.id);
  const ctx = await requestCtx();
  await recordAttempt({ userId: u.id, email: u.email, ctx, device: await knownDevice(u.id), step: "change", ok: true, reason: "changed" });
  await startSession(nu);
  redirect("/");
}
