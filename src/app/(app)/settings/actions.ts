"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/stock";
import { storeUpload } from "@/lib/files";

export type SettingsState = { error?: string; ok?: boolean } | undefined;
const str = (max = 200) => z.string().trim().max(max).default("");
const S = z.object({
  name: z.string().trim().min(1).max(200), owner: str(), street: str(), zip: str(20), city: str(100),
  country: z.string().trim().length(2).transform((s) => s.toUpperCase()).default("DE"),
  email: str(), phone: str(60), website: str(),
  vatId: str(30).transform((s) => s.replace(/\s/g, "").toUpperCase()), taxNumber: str(30),
  bankName: str(), iban: str(40).transform((s) => s.replace(/\s/g, "").toUpperCase()), bic: str(15).transform((s) => s.toUpperCase()),
  defaultPaymentDays: z.coerce.number().int().min(0).max(365), offerValidityDays: z.coerce.number().int().min(1).max(365),
  invoiceFooter: str(1000),
  datevConsultant: z.string().trim().regex(/^(\d{4,7})?$/).transform((s) => (s ? Number(s) : null)),
  datevClient: z.string().trim().regex(/^(\d{1,5})?$/).transform((s) => (s ? Number(s) : null)),
  chartOfAccounts: z.enum(["SKR03", "SKR04"]).default("SKR03"),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
  advisorEmail: str(),
  showGuide: z.string().optional().transform((v) => v === "on"),
});

export async function saveSettings(_: SettingsState, fd: FormData): Promise<SettingsState> {
  const session = await requireSession();
  const p = S.safeParse(Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")));
  if (!p.success) return { error: p.error.issues.some((i) => i.path[0] === "datevConsultant" || i.path[0] === "datevClient") ? "datev" : "required" };
  const data: typeof p.data & { logoFileId?: string | null } = { ...p.data };
  const logo = fd.get("logo");
  if (logo instanceof File && logo.size > 0) {
    if (!["image/png", "image/jpeg"].includes(logo.type) || logo.size > 2 * 1024 * 1024) return { error: "logoType" };
    data.logoFileId = await storeUpload(logo);
  } else if (fd.get("removeLogo") === "on") data.logoFileId = null;
  await db.transaction(async (tx) => {
    await tx.insert(schema.companySettings).values({ id: "company", ...data })
      .onConflictDoUpdate({ target: schema.companySettings.id, set: data });
    await audit(tx, { entity: "company_settings", entityId: "company", action: "update", after: data, userId: session.uid });
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function saveAccountsAction(_: SettingsState, fd: FormData): Promise<SettingsState> {
  const session = await requireSession();
  const overrides: Record<string, number> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("acc_") || typeof v !== "string" || !v.trim()) continue;
    if (!/^\d{4,8}$/.test(v.trim())) return { error: "account" };
    overrides[k.slice(4)] = Number(v.trim());
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.companySettings).set({ accountOverrides: overrides }).where(eq(schema.companySettings.id, "company"));
    await audit(tx, { entity: "company_settings", entityId: "company", action: "accounts", after: overrides, userId: session.uid });
  });
  revalidatePath("/settings/accounts");
  return { ok: true };
}
