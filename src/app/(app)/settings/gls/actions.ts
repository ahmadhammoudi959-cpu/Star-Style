"use server";
/** GLS-Zugangsdaten speichern und Verbindung testen (Recht „Einstellungen“). Ohne revalidatePath – die Seite lädt danach selbst neu. */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { glsTestConnection, saveGlsSettings } from "@/lib/gls-client";

export type GlsSaveResult = { ok: true } | { ok: false; error: string; detail?: string };

const input = z.object({
  endpoint: z.string().max(500), user: z.string().max(200), password: z.string().max(500), contactId: z.string().max(200), flex: z.boolean(),
});

export async function saveGlsAction(raw: unknown): Promise<GlsSaveResult> {
  const s = await requirePerm("settings");
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "error" };
  try {
    const r = await saveGlsSettings(p.data, s.uid);
    return "problem" in r ? { ok: false, error: r.problem } : { ok: true };
  } catch (e) {
    console.error("gls settings", e);
    return { ok: false, error: "error" };
  }
}

export async function testGlsAction(): Promise<GlsSaveResult> {
  await requirePerm("settings");
  const r = await glsTestConnection();
  return r.ok ? { ok: true } : { ok: false, error: r.code, detail: r.message };
}
