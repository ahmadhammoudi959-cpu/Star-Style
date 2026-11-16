"use server";
/** Postfach-Zugang speichern und prüfen (Recht „Einstellungen“). Ohne revalidatePath – die Seite lädt danach selbst neu. */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { saveMailSettings, testMailbox } from "@/lib/mailbox";

export type MailSaveResult = { ok: true; total?: number; unseen?: number } | { ok: false; error: string; detail?: string };

const input = z.object({
  imapHost: z.string().max(253), imapPort: z.number().int(), smtpHost: z.string().max(253), smtpPort: z.number().int(),
  user: z.string().max(254), password: z.string().max(300), fromName: z.string().max(80), signature: z.string().max(2000), signatureHtml: z.string().max(40_000).optional(),
  disconnect: z.boolean().optional(),
});

export async function saveMailAction(raw: unknown): Promise<MailSaveResult> {
  const s = await requirePerm("settings");
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "error" };
  try {
    const r = await saveMailSettings(p.data, s.uid);
    if ("problem" in r) return { ok: false, error: r.problem };
    if (p.data.disconnect) return { ok: true };
    // gleich prüfen, ob die Anmeldung klappt – gespeichert ist es so oder so
    const t = await testMailbox();
    return t.ok ? { ok: true, total: t.total, unseen: t.unseen } : { ok: false, error: `saved_${t.code}`, detail: t.message };
  } catch (e) {
    console.error("mail settings", e);
    return { ok: false, error: "error" };
  }
}

export async function testMailAction(): Promise<MailSaveResult> {
  await requirePerm("settings");
  const t = await testMailbox();
  return t.ok ? { ok: true, total: t.total, unseen: t.unseen } : { ok: false, error: t.code, detail: t.message };
}
