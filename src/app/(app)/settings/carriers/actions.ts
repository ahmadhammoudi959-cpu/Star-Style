"use server";
/**
 * Versanddienste ändern (Seite „Versanddienste“). Jede Änderung wird sofort gespeichert. Ohne revalidatePath – die Seite
 * übernimmt den neuen Stand aus der Antwort (sonst kann der Übergang im Browser hängen bleiben, CLAUDE.md „Hängender Übergang“).
 */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { changeCarriers } from "@/lib/carrier-settings";
import type { CarrierProblem, CarrierSettings } from "@/lib/carriers";

const key = z.string().min(1).max(40);
const input = z.union([
  z.object({ op: z.literal("add"), name: z.string().max(500), url: z.string().max(2000) }),
  z.object({ op: z.literal("edit"), key, name: z.string().max(500), url: z.string().max(2000) }),
  z.object({ op: z.enum(["remove", "show", "hide", "default", "up", "down"]), key }),
]);

export type CarrierResult = { ok: true; settings: CarrierSettings } | { ok: false; error: CarrierProblem | "error" };

export async function carrierAction(raw: unknown): Promise<CarrierResult> {
  const s = await requirePerm("settings");
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "error" };
  try {
    const r = await changeCarriers(p.data, s.uid);
    return "problem" in r ? { ok: false, error: r.problem } : { ok: true, settings: r.settings };
  } catch (e) {
    console.error("carriers", e);
    return { ok: false, error: "error" };
  }
}
