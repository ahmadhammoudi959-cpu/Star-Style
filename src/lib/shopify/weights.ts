import "server-only";
/**
 * Gewicht an die Shops melden (Wunsch Inhaber 03.11.2026: Versand nach Gewicht). In Shopify hängt das Gewicht am Lagerartikel
 * der Variante → inventoryItemUpdate je verbundener Variante (Recht write_inventory). Unser System ist die Wahrheit:
 * geändertes Gewicht → wird gemeldet; ohne Gewicht (null) bleibt der Wert im Shop unverändert.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, type Shop, type ShopChannel } from "./client";
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
    const r = await sendWeights(shop, channel, rows.rows);
    await logEvent(channel, r.failed ? "warn" : "info", "products", `weightsPushed:${r.updated}|${r.failed}${r.firstError ? `|${r.firstError.slice(0, 200)}` : ""}`);
    out.push({ channel, updated: r.updated, failed: r.failed });
  }
  return out;
}

/**
 * Meldet die Gewichte und merkt sie sich je Shop-Variante (shop_variants.pushed_weight_grams). Lehnt Shopify ein Gewicht ab
 * (userErrors), gilt es auch als gemeldet – sonst würde der Worker es alle 5 min erneut versuchen; Netz/Drosselung → später neu.
 */
async function sendWeights(shop: Shop, channel: ShopChannel, rows: { inventory_item_id: string; weight_grams: number }[]) {
  let updated = 0, failed = 0, firstError = "";
  for (const r of rows) {
    const grams = Number(r.weight_grams);
    try {
      const d = await gql<{ inventoryItemUpdate: { userErrors: { message: string }[] } }>(shop, UPDATE_M,
        { id: r.inventory_item_id, input: shopWeight(grams) });
      if (d.inventoryItemUpdate.userErrors.length) { failed++; firstError ||= d.inventoryItemUpdate.userErrors[0].message; }
      else updated++;
      await db.execute(sql`update shop_variants set pushed_weight_grams = ${grams} where channel = ${channel} and inventory_item_id = ${r.inventory_item_id}`);
    } catch (e) { failed++; firstError ||= (e as Error).message; }
  }
  return { updated, failed, firstError };
}

/**
 * Worker (alle 5 min): Gewichte, die im Shop noch fehlen oder veraltet sind – z. B. nach dem Delta-Pro-Abgleich (Migration 0032),
 * wenn der Shop beim Speichern nicht erreichbar war oder bei Gewichten aus Wareneingang/Import. Höchstens `limit` je Shop und Lauf.
 */
export async function pushDueWeights(limit = 150): Promise<{ channel: ShopChannel; updated: number; failed: number }[]> {
  const out: { channel: ShopChannel; updated: number; failed: number }[] = [];
  for (const channel of CHANNELS) {
    const shop = await getShop(channel);
    if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc)) continue;
    const rows = await db.execute<{ inventory_item_id: string; weight_grams: number }>(sql`
      select distinct on (sv.inventory_item_id) sv.inventory_item_id, v.weight_grams from shop_variants sv join variants v on v.id = sv.variant_id
      where sv.channel = ${channel} and sv.inventory_item_id <> '' and coalesce(v.weight_grams, 0) > 0
        and sv.pushed_weight_grams is distinct from v.weight_grams
      order by sv.inventory_item_id limit ${limit}`);
    if (!rows.rows.length) continue;
    const r = await sendWeights(shop, channel, rows.rows);
    await logEvent(channel, r.failed ? "warn" : "info", "products", `weightsPushed:${r.updated}|${r.failed}${r.firstError ? `|${r.firstError.slice(0, 200)}` : ""}`);
    out.push({ channel, updated: r.updated, failed: r.failed });
  }
  return out;
}

/** Im Hintergrund melden (Speichern soll nicht auf Shopify warten); Fehler stehen im Shop-Protokoll. */
export function pushWeightsLater(variantIds: string[]) {
  if (!variantIds.length) return;
  void pushWeights(variantIds).catch((e) => console.error("shopify weights", e));
}
