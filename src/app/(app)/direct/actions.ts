"use server";
/**
 * Direktverkauf (Listen vom Bestell-Link). Ohne revalidatePath – der Browser lädt danach selbst neu bzw. öffnet den
 * erstellten Beleg (siehe „Hängender Übergang nach Server-Action“ in CLAUDE.md).
 */
import { can, requirePerm } from "@/lib/auth";
import { DirectError, convertDirectOrder, newDirectLink, rejectDirectOrder, reopenDirectOrder, setDirectLinkOn } from "@/lib/direct";
import { DIRECT_GROUPS, type DirectGroup } from "@/lib/direct-rules";

export type DirectResult = { ok?: boolean; id?: string; error?: string };

const fail = (e: unknown): DirectResult => {
  if (e instanceof DirectError) return { error: e.code };
  console.error("direct", e);
  return { error: "error" };
};
const str = (v: unknown, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");

/** Liste → Angebot bzw. Rechnungsentwurf für den gewählten Kunden */
export async function convertDirectAction(id: string, customerId: string, kind: string): Promise<DirectResult> {
  const s = await requirePerm("direct");
  const k = kind === "offer" ? "offer" : "invoice";
  if (!can(s, k === "offer" ? "sales.offers" : "sales.invoices")) return { error: "noRight" };
  if (!str(customerId)) return { error: "customer" };
  try { return { ok: true, id: await convertDirectOrder(str(id), { customerId: str(customerId), kind: k }, s.uid) }; }
  catch (e) { return fail(e); }
}

export async function rejectDirectAction(id: string, reason: string): Promise<DirectResult> {
  const s = await requirePerm("direct");
  try { await rejectDirectOrder(str(id), str(reason, 500), s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

export async function reopenDirectAction(id: string): Promise<DirectResult> {
  const s = await requirePerm("direct");
  try { await reopenDirectOrder(str(id), s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

/** Bestell-Link je Preisgruppe: erstellen/erneuern (alter gilt nicht mehr), ein-/ausschalten */
export async function directLinkAction(group: string, op: string): Promise<DirectResult> {
  const s = await requirePerm("direct.link");
  if (!DIRECT_GROUPS.includes(group as DirectGroup)) return { error: "error" };
  const g = group as DirectGroup;
  try {
    if (op === "create" || op === "renew") await newDirectLink(g, s.uid);
    else if (op === "on" || op === "off") await setDirectLinkOn(g, op === "on", s.uid);
    else return { error: "error" };
    return { ok: true };
  } catch (e) { return fail(e); }
}
