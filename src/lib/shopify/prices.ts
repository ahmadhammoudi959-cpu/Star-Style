import "server-only";
/**
 * Preise an die Shops melden (Wunsch Inhaber 09.11.2026: „Preis ändern → im Shop auch“). Unser System ist die Wahrheit:
 * Shop-Preis = Großhandelspreis Salon (retail_price_cents, Variantenpreis vor Artikelpreis), bei Shops mit Bruttopreisen inkl. MwSt.
 * Geänderter Preis/MwSt.-Satz beim Speichern → Zeile in shop_price_dirty → das Speichern meldet sofort (wartet bis 8 s, damit
 * über dem Formular steht, ob der Preis im Shop angekommen ist); klappt es nicht (Shop kurz weg), versucht der Worker es alle
 * 5 min wieder. Gemeldet wird nur, wo der Preis im Shop abweicht.
 * „Alle Preise an den Shop senden“ (Shop-Seite) gleicht alle verbundenen Varianten eines Shops ab.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, ShopifyError, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { planPriceUpdates, shopPriceCents, type ShopVariantPrice } from "./product-push-map";

const NODES_Q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price product { id } } } }`;
const UPDATE_M = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`;

/** Shop kurz weg / gedrosselt → später noch einmal; Rechte- oder Datenfehler nicht (stehen im Protokoll) */
const transient = (e: unknown) => !(e instanceof ShopifyError) || e.code === "network" || e.code === "throttled";

/**
 * Ergebnis je Shop. priceCents = Preis im Shop (wie dort gezeigt, ggf. brutto), wenn alle Varianten denselben haben;
 * own = mindestens eine Größe/Farbe hat einen eigenen Preis (der gilt dann im Shop, nicht der Artikelpreis).
 */
export type PricePush = { channel: ShopChannel; updated: number; failed: number; unchanged: number; retry: boolean; priceCents: number | null; own: boolean };

/** productIds: nur diese Artikel; ohne: alle verbundenen Varianten des Shops. only: nur dieser Shop. */
export async function pushPrices(productIds?: string[], only?: ShopChannel): Promise<PricePush[]> {
  if (productIds && !productIds.length) return [];
  const out: PricePush[] = [];
  for (const channel of CHANNELS) {
    if (only && channel !== only) continue;
    const shop = await getShop(channel);
    if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc)) continue;
    const rows = (await db.execute<{ shop_variant_id: string; net: number; vat: number; own: boolean }>(sql`
      select sv.shop_variant_id, coalesce(nullif(v.retail_price_cents, 0), p.retail_price_cents) as net, p.vat_rate_bp as vat,
        coalesce(v.retail_price_cents, 0) > 0 as own
      from shop_variants sv join variants v on v.id = sv.variant_id join products p on p.id = v.product_id
      where sv.channel = ${channel} and v.active
        ${productIds ? sql`and p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`)).rows
      .map((r) => ({ shopVariantId: r.shop_variant_id, netCents: Number(r.net), vatRateBp: Number(r.vat), own: Boolean(r.own) }));
    if (!rows.length) continue;
    let updated = 0, failed = 0, unchanged = 0, firstError = "", retry = false, priceCents: number | null = null;
    try {
      const { taxesIncluded } = (await gql<{ shop: { taxesIncluded: boolean } }>(shop, `{ shop { taxesIncluded } }`)).shop;
      const want = new Set(rows.map((r) => shopPriceCents(r.netCents, r.vatRateBp, taxesIncluded)));
      if (want.size === 1) priceCents = [...want][0];
      const current: ShopVariantPrice[] = [];
      for (let i = 0; i < rows.length; i += 100) {
        const d = await gql<{ nodes: ({ id: string; price: string; product: { id: string } } | null)[] }>(shop, NODES_Q,
          { ids: rows.slice(i, i + 100).map((r) => r.shopVariantId) });
        for (const n of d.nodes) if (n?.id && n.product) current.push({ id: n.id, price: n.price, productId: n.product.id });
      }
      const plan = planPriceUpdates(rows, current, taxesIncluded);
      unchanged = plan.unchanged;
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
    out.push({ channel, updated, failed, unchanged, retry, priceCents, own: rows.some((r) => r.own) });
  }
  return out;
}

/** Vormerkungen löschen, die seit dem Lesen nicht neu gesetzt wurden (sonst ginge ein gleich danach gespeicherter Preis verloren) */
async function clearMarks(marks: { product_id: string; at: string }[]) {
  if (!marks.length) return;
  await db.execute(sql`delete from shop_price_dirty where (product_id, at) in (${sql.join(marks.map((m) => sql`(${m.product_id}, ${m.at}::timestamptz)`), sql`, `)})`);
}

/** Vorgemerkte Artikel melden (Worker alle 5 min); Vormerkung bleibt nur, wenn ein Shop gerade nicht erreichbar war. */
export async function pushDirtyPrices(): Promise<void> {
  const marks = (await db.execute<{ product_id: string; at: string }>(sql`select product_id, at::text as at from shop_price_dirty order by at limit 200`)).rows;
  if (!marks.length) return;
  const res = await pushPrices(marks.map((m) => m.product_id));
  if (res.some((r) => r.retry)) return;
  await clearMarks(marks);
}

/**
 * Nach dem Speichern: diesen Artikel sofort melden und höchstens timeoutMs warten. null = dauert länger (läuft im Hintergrund
 * weiter, die Vormerkung bleibt bis zum Erfolg). [] = Artikel ist mit keinem Shop verbunden.
 */
export async function pushProductPrices(productId: string, timeoutMs = 8000): Promise<PricePush[] | null> {
  const marks = (await db.execute<{ product_id: string; at: string }>(sql`select product_id, at::text as at from shop_price_dirty where product_id = ${productId}`)).rows;
  const work = pushPrices([productId]).then(async (res) => {
    if (!res.some((r) => r.retry)) await clearMarks(marks);
    return res;
  });
  work.catch((e) => console.error("shopify prices", e));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}
