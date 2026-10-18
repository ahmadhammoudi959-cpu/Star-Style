"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/stock";

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
});

export async function saveSettings(_: SettingsState, fd: FormData): Promise<SettingsState> {
  const session = await requireSession();
  const p = S.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  await db.transaction(async (tx) => {
    await tx.insert(schema.companySettings).values({ id: "company", ...p.data })
      .onConflictDoUpdate({ target: schema.companySettings.id, set: p.data });
    await audit(tx, { entity: "company_settings", entityId: "company", action: "update", after: p.data, userId: session.uid });
  });
  revalidatePath("/settings");
  return { ok: true };
}
