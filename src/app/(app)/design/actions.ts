"use server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePerm } from "@/lib/auth";
import { audit } from "@/lib/stock";
import { designDiff, parseDesign } from "@/lib/doc-design";

/**
 * Belegdesign speichern (Seite „Belegdesign“). Gespeichert werden nur die Abweichungen vom Standard ({} = ursprüngliches
 * Aussehen); alles wird geprüft und begrenzt (parseDesign). Ohne revalidatePath – die Seite hält den Stand selbst
 * (sonst kann der Übergang im Browser hängen bleiben, siehe CLAUDE.md „Hängender Übergang“).
 */
export async function saveDocDesign(json: string): Promise<{ ok: true } | { error: "saveError" }> {
  const session = await requirePerm("design");
  if (typeof json !== "string" || json.length > 64_000) return { error: "saveError" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { error: "saveError" }; }
  const next = designDiff(parseDesign(raw));
  try {
    await db.transaction(async (tx) => {
      const cur = await tx.query.companySettings.findFirst();
      if (cur) await tx.update(schema.companySettings).set({ docDesign: next }).where(eq(schema.companySettings.id, cur.id));
      else await tx.insert(schema.companySettings).values({ id: "company", docDesign: next });
      await audit(tx, { entity: "settings", entityId: "doc_design", action: "update", before: cur?.docDesign ?? {}, after: next, userId: session.uid });
    });
  } catch (e) {
    console.error("save doc design", e);
    return { error: "saveError" };
  }
  return { ok: true };
}
