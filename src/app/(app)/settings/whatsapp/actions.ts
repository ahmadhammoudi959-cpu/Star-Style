"use server";
/** WhatsApp-Zugang speichern und prüfen (Recht „Einstellungen“). Ohne revalidatePath – die Seite lädt danach selbst neu. */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { saveWaSettings, testWhatsapp } from "@/lib/whatsapp";

export type WaSaveResult = { ok: true; displayPhone?: string; verifiedName?: string; quality?: string } | { ok: false; error: string; detail?: string };

const input = z.object({
  phoneNumberId: z.string().max(40), wabaId: z.string().max(40), accessToken: z.string().max(2000), appSecret: z.string().max(200),
  apiVersion: z.string().max(10), disconnect: z.boolean().optional(),
});

export async function saveWaAction(raw: unknown): Promise<WaSaveResult> {
  const s = await requirePerm("settings");
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "error" };
  try {
    const r = await saveWaSettings(p.data, s.uid);
    if ("problem" in r) return { ok: false, error: r.problem };
    if (p.data.disconnect) return { ok: true };
    const t = await testWhatsapp();
    return t.ok ? { ok: true, displayPhone: t.displayPhone, verifiedName: t.verifiedName, quality: t.quality } : { ok: false, error: `saved_${t.code}`, detail: t.message };
  } catch (e) {
    console.error("whatsapp settings", e);
    return { ok: false, error: "error" };
  }
}

export async function testWaAction(): Promise<WaSaveResult> {
  await requirePerm("settings");
  const t = await testWhatsapp();
  return t.ok ? { ok: true, displayPhone: t.displayPhone, verifiedName: t.verifiedName, quality: t.quality } : { ok: false, error: t.code, detail: t.message };
}
