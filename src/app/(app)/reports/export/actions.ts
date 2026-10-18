"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { createAndStorePackage } from "@/lib/advisor";
import { lockMonth, unlockMonth } from "@/lib/periods";
import { mailConfigured, sendMail } from "@/lib/mail";
import { todayIso } from "@/lib/dates";

export type ExportState = { error?: string; ok?: { fileId: string; name: string; bookings: number; missingReceipts: number; locked: boolean } } | undefined;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function createPackageAction(_: ExportState, fd: FormData): Promise<ExportState> {
  const s = await requireSession();
  const month = String(fd.get("month"));
  if (!MONTH.test(month)) return { error: "month" };
  const lock = fd.get("lock") === "on";
  if (lock && month >= todayIso().slice(0, 7)) return { error: "notPast" };
  try {
    const pkg = await createAndStorePackage(month, s.name, s.uid);
    if (lock) await lockMonth(month, s.uid);
    revalidatePath("/reports/export"); revalidatePath("/expenses"); revalidatePath("/reports");
    return { ok: { fileId: pkg.fileId, name: pkg.name, bookings: pkg.bookings, missingReceipts: pkg.missingReceipts, locked: lock } };
  } catch (e) {
    console.error(e);
    return { error: e instanceof Error && e.message.includes("Zeitraum") ? "dateRange" : "error" };
  }
}

export async function sendPackageAction(_: { error?: string; ok?: boolean } | undefined, fd: FormData) {
  await requireSession();
  if (!mailConfigured()) return { error: "mail" };
  const to = String(fd.get("to") ?? "").trim();
  const fileId = String(fd.get("fileId"));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { error: "email" };
  const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, fileId) });
  if (!f) return { error: "error" };
  const company = await db.query.companySettings.findFirst();
  const month = f.name.match(/\d{4}-\d{2}/)?.[0] ?? "";
  try {
    await sendMail({
      to, subject: `Buchhaltungsunterlagen ${month} – ${company?.name ?? ""}`,
      text: `Guten Tag,\n\nanbei die Unterlagen für ${month}: DATEV-Buchungsstapel, Debitoren/Kreditoren, Ausgangsrechnungen, Belege der Ausgaben und eine Monatsübersicht.\n\nMit freundlichen Grüßen\n${company?.name ?? ""}`,
      attachments: [{ filename: f.name, content: Buffer.from(f.data) }],
    });
    if (company && company.advisorEmail !== to) await db.update(schema.companySettings).set({ advisorEmail: to }).where(eq(schema.companySettings.id, company.id));
  } catch (e) { console.error(e); return { error: "send" }; }
  return { ok: true };
}

export async function unlockAction(fd: FormData) {
  await requireSession();
  const month = String(fd.get("month"));
  if (MONTH.test(month)) await unlockMonth(month);
  revalidatePath("/reports/export"); revalidatePath("/expenses");
}
