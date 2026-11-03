import "server-only";
/**
 * Gewicht an die Shops melden (Wunsch Inhaber 03.11.2026: Versand nach Gewicht). In Shopify hängt das Gewicht am Lagerartikel
 * der Variante → inventoryItemUpdate je verbundener Variante (Recht write_inventory). Unser System ist die Wahrheit:
 * geändertes Gewicht → wird gemeldet; ohne Gewicht (null) bleibt der Wert im Shop unverändert.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { shopWeight } from "./product-push-map";

const UPDATE_M = `mutation($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) {
  inventoryItem { id } userErrors { field message } } }`;

/** variantIds: nur diese (nach dem Speichern / Wareneingang); ohne: alle verbundenen Varianten mit Gewicht. only: nur dieser Shop. */
export async function pushWeights(variantIds?: string[], only?: ShopChannel): Promise<{ channel: ShopChannel; updated: number; failed: number }[]> {
  if (variantIds && !variantIds.length) return [];
  const out: { channel: ShopChannel; updated: number; failed: number }[] = [];
  for (const channel of CHANNELS) {
    if (only && channel !== only) continue;
    const shop = await getShop(channel);
    if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc)) continue;
    const rows = await db.execute<{ inventory_item_id: string; weight_grams: number }>(sql`
      select distinct sv.inventory_item_id, v.weight_grams from shop_variants sv join variants v on v.id = sv.variant_id
      where sv.channel = ${channel} and sv.inventory_item_id <> '' and coalesce(v.weight_grams, 0) > 0
        ${variantIds ? sql`and v.id in (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`);
    if (!rows.rows.length) continue;
    let updated = 0, failed = 0, firstError = "";
    for (const r of rows.rows) {
      try {
        const d = await gql<{ inventoryItemUpdate: { userErrors: { message: string }[] } }>(shop, UPDATE_M,
          { id: r.inventory_item_id, input: shopWeight(Number(r.weight_grams)) });
        if (d.inventoryItemUpdate.userErrors.length) { failed++; firstError ||= d.inventoryItemUpdate.userErrors[0].message; }
        else updated++;
      } catch (e) { failed++; firstError ||= (e as Error).message; }
    }
    await logEvent(channel, failed ? "warn" : "info", "products", `weightsPushed:${updated}|${failed}${firstError ? `|${firstError.slice(0, 200)}` : ""}`);
    out.push({ channel, updated, failed });
  }
  return out;
}

/** Im Hintergrund melden (Speichern soll nicht auf Shopify warten); Fehler stehen im Shop-Protokoll. */
export function pushWeightsLater(variantIds: string[]) {
  if (!variantIds.length) return;
  void pushWeights(variantIds).catch((e) => console.error("shopify weights", e));
}
