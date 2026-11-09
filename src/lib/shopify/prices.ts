import "server-only";
/**
 * Preise an die Shops melden (Wunsch Inhaber 09.11.2026: „Preis ändern → im Shop auch“). Unser System ist die Wahrheit:
 * Shop-Preis = Großhandelspreis Salon (retail_price_cents, Variantenpreis vor Artikelpreis), bei Shops mit Bruttopreisen inkl. MwSt.
 * Geänderter Preis/MwSt.-Satz beim Speichern → Zeile in shop_price_dirty → sofort im Hintergrund gemeldet; klappt es nicht
 * (Shop kurz weg), versucht der Worker es alle 5 min wieder. Gemeldet wird nur, wo der Preis im Shop abweicht.
 * „Alle Preise an den Shop senden“ (Shop-Seite) gleicht alle verbundenen Varianten eines Shops ab.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, ShopifyError, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { planPriceUpdates, type ShopVariantPrice } from "./product-push-map";

const NODES_Q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price product { id } } } }`;
const UPDATE_M = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`;

/** Shop kurz weg / gedrosselt → später noch einmal; Rechte- oder Datenfehler nicht (stehen im Protokoll) */
const transient = (e: unknown) => !(e instanceof ShopifyError) || e.code === "network" || e.code === "throttled";

type Result = { channel: ShopChannel; updated: number; failed: number; retry: boolean };

/** productIds: nur diese Artikel; ohne: alle verbundenen Varianten des Shops. only: nur dieser Shop. */
export async function pushPrices(productIds?: string[], only?: ShopChannel): Promise<Result[]> {
  if (productIds && !productIds.length) return [];
  const out: Result[] = [];
  for (const channel of CHANNELS) {
    if (only && channel !== only) continue;
    const shop = await getShop(channel);
    if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc)) continue;
    const rows = (await db.execute<{ shop_variant_id: string; net: number; vat: number }>(sql`
      select sv.shop_variant_id, coalesce(nullif(v.retail_price_cents, 0), p.retail_price_cents) as net, p.vat_rate_bp as vat
      from shop_variants sv join variants v on v.id = sv.variant_id join products p on p.id = v.product_id
      where sv.channel = ${channel} and v.active
        ${productIds ? sql`and p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`)).rows
      .map((r) => ({ shopVariantId: r.shop_variant_id, netCents: Number(r.net), vatRateBp: Number(r.vat) }));
    if (!rows.length) continue;
    let updated = 0, failed = 0, firstError = "", retry = false;
    try {
      const { taxesIncluded } = (await gql<{ shop: { taxesIncluded: boolean } }>(shop, `{ shop { taxesIncluded } }`)).shop;
      const current: ShopVariantPrice[] = [];
      for (let i = 0; i < rows.length; i += 100) {
        const d = await gql<{ nodes: ({ id: string; price: string; product: { id: string } } | null)[] }>(shop, NODES_Q,
          { ids: rows.slice(i, i + 100).map((r) => r.shopVariantId) });
        for (const n of d.nodes) if (n?.id && n.product) current.push({ id: n.id, price: n.price, productId: n.product.id });
      }
      const plan = planPriceUpdates(rows, current, taxesIncluded);
      for (const u of plan.updates) {
        try {
          const d = await gql<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(shop, UPDATE_M, u);
          const errs = d.productVariantsBulkUpdate.userErrors;
          if (errs.length) { failed += u.variants.length; firstError ||= errs[0].message; } else updated += u.variants.length;
        } catch (e) { failed += u.variants.length; firstError ||= (e as Error).message; retry ||= transient(e); }
      }
    } catch (e) {
      // Shop nicht erreichbar o. Ä. → später noch einmal (Worker); Rechte-/Abfragefehler stehen im Protokoll
      failed = rows.length; firstError = (e as Error).message; retry = transient(e);
    }
    if (updated || failed || !productIds)
      await logEvent(channel, failed ? "warn" : "info", "products", `pricesPushed:${updated}|${failed}${firstError ? `|${firstError.slice(0, 200)}` : ""}`);
    out.push({ channel, updated, failed, retry });
  }
  return out;
}

/** Vorgemerkte Artikel melden; Vormerkung bleibt nur, wenn ein Shop gerade nicht erreichbar war. */
export async function pushDirtyPrices(): Promise<void> {
  const ids = (await db.execute<{ product_id: string }>(sql`select product_id from shop_price_dirty order by at limit 200`)).rows.map((r) => r.product_id);
  if (!ids.length) return;
  const res = await pushPrices(ids);
  if (res.some((r) => r.retry)) return;
  await db.execute(sql`delete from shop_price_dirty where product_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
}

let running = false;
/** Nach dem Speichern im Hintergrund (Speichern wartet nicht auf Shopify). */
export function pushPricesLater() {
  if (running) return;
  running = true;
  void pushDirtyPrices().catch((e) => console.error("shopify prices", e)).finally(() => { running = false; });
}
