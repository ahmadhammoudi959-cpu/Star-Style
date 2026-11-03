import "server-only";
/** Gewicht einzelner Größen/Farben setzen (z. B. beim Wareneingang nachgetragen) – mit Protokoll, danach an die Shops melden. */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { pushWeightsLater } from "./shopify/weights";

export async function setVariantWeights(list: { variantId: string; grams: number }[], userId?: string): Promise<string[]> {
  if (!list.length) return [];
  const changed: string[] = [];
  await db.transaction(async (tx) => {
    const current = new Map((await tx.select({ id: schema.variants.id, w: schema.variants.weightGrams }).from(schema.variants)
      .where(inArray(schema.variants.id, list.map((x) => x.variantId)))).map((r) => [r.id, r.w]));
    for (const { variantId, grams } of list) {
      if (!current.has(variantId) || current.get(variantId) === grams) continue;
      await tx.update(schema.variants).set({ weightGrams: grams }).where(eq(schema.variants.id, variantId));
      await audit(tx, { entity: "variant", entityId: variantId, action: "weight", before: { weightGrams: current.get(variantId) ?? null }, after: { weightGrams: grams }, userId });
      changed.push(variantId);
    }
  });
  pushWeightsLater(changed);
  return changed;
}
