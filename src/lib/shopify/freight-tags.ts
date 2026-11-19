import "server-only";
/**
 * Versandart → Tag „spedition“ an den Shop-Produkten (Wunsch Inhaber 19.11.2026: Möbel und große Teile erkennt das System
 * selbst aus Gewicht und Paketmaßen, src/lib/shipping-class.ts). Das Theme zeigt bei diesem Tag den Hinweis „Lieferung per
 * Spedition“, und der Versandtarif im Shop gilt nur für Produkte OHNE diesen Tag (Kollektion „Paketversand“, Bedingung
 * „Tag ist nicht gleich spedition“) → Möbel im Checkout nur mit Abholung, Lieferung auf Anfrage per WhatsApp.
 * Unser System ist die Wahrheit: der Worker gleicht alle 5 min ab (nur Abweichungen, gemerkt in shop_variants.pushed_freight);
 * nach dem Speichern eines Artikels gleich im Hintergrund. Andere Tags im Shop bleiben unberührt.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, type Shop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { configured, withFreshToken } from "./admin";
import { FREIGHT_TAG } from "@/lib/shipping-class";
import { freightByProduct } from "@/lib/freight";

const NODES_Q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id product { id tags } } } }`;
const ADD_M = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
const REMOVE_M = `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`;

export type FreightTagResult = { channel: ShopChannel; added: number; removed: number; same: number; failed: number };

/**
 * Tags im Shop angleichen. productIds: nur diese Artikel (nach dem Speichern), sonst alle, deren gemerkter Stand nicht zur
 * Versandart passt (oder noch nie gesetzt). Höchstens `limit` Shop-Produkte je Shop und Lauf.
 * Shopify lehnt ab (userErrors) oder Variante gibt es im Shop nicht mehr → gilt als erledigt (sonst jede 5 min wieder);
 * Netz/Drosselung → nicht gemerkt, nächster Lauf.
 */
export async function pushFreightTags(opts: { productIds?: string[]; limit?: number; only?: ShopChannel } = {}): Promise<FreightTagResult[]> {
  const limit = opts.limit ?? 150;
  const out: FreightTagResult[] = [];
  if (opts.productIds && !opts.productIds.length) return out;
  const freight = await freightByProduct(opts.productIds);
  for (const channel of CHANNELS) {
    if (opts.only && channel !== opts.only) continue;
    const shop = await getShop(channel);
    if (!configured(shop)) continue;
    const rows = (await db.execute<{ id: string; shop_variant_id: string; pushed_freight: boolean | null; product_id: string }>(sql`
      select sv.id, sv.shop_variant_id, sv.pushed_freight, v.product_id from shop_variants sv join variants v on v.id = sv.variant_id
      where sv.channel = ${channel}
        ${opts.productIds ? sql`and v.product_id in (${sql.join(opts.productIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      order by sv.id`)).rows;
    const due = rows.filter((r) => r.pushed_freight !== (freight.get(r.product_id) ?? false));
    if (!due.length) continue;
    const r = await sendTags(shop, channel, due, freight, limit);
    out.push(r);
    if (r.added || r.removed || r.failed)
      await logEvent(channel, r.failed ? "warn" : "info", "products", `freightTags:+${r.added}|-${r.removed}|${r.failed}`).catch(() => {});
  }
  return out;
}

async function sendTags(shop: Shop, channel: ShopChannel, due: { id: string; shop_variant_id: string; product_id: string }[],
  freight: Map<string, boolean>, limit: number): Promise<FreightTagResult> {
  const r: FreightTagResult = { channel, added: 0, removed: 0, same: 0, failed: 0 };
  // Shop-Produkt (mit Tags) zu jeder fälligen Shop-Variante
  const productOf = new Map<string, { id: string; tags: string[] } | null>();
  try {
    for (let i = 0; i < due.length; i += 100) {
      const ids = due.slice(i, i + 100).map((x) => x.shop_variant_id);
      const d = await withFreshToken(shop, () => gql<{ nodes: ({ id: string; product: { id: string; tags: string[] } } | null)[] }>(shop, NODES_Q, { ids }));
      ids.forEach((id, k) => productOf.set(id, d.nodes[k]?.product ?? null));
    }
  } catch (e) {
    r.failed += due.length;
    console.error("shopify freight tags", channel, e);
    return r;
  }
  // je Shop-Produkt: soll Spedition sein, sobald einer unserer verbundenen Artikel Spedition ist
  const groups = new Map<string, { tags: string[]; want: boolean; rowIds: string[] }>();
  const gone: Record<"true" | "false", string[]> = { true: [], false: [] }; // Variante gibt es im Shop nicht mehr → nicht jedes Mal neu
  for (const x of due) {
    const p = productOf.get(x.shop_variant_id);
    if (!p) { gone[String(freight.get(x.product_id) ?? false) as "true" | "false"].push(x.id); continue; }
    const g = groups.get(p.id) ?? { tags: p.tags, want: false, rowIds: [] };
    g.want ||= freight.get(x.product_id) ?? false;
    g.rowIds.push(x.id);
    groups.set(p.id, g);
  }
  await mark(gone.true, true);
  await mark(gone.false, false);
  let n = 0;
  for (const [pid, g] of groups) {
    if (n++ >= limit) break;
    const has = g.tags.some((t) => t.trim().toLowerCase() === FREIGHT_TAG);
    try {
      if (g.want !== has) {
        const d = await withFreshToken(shop, () => gql<Record<string, { userErrors: { message: string }[] }>>(shop, g.want ? ADD_M : REMOVE_M, { id: pid, tags: [FREIGHT_TAG] }));
        const errs = (d.tagsAdd ?? d.tagsRemove)?.userErrors ?? [];
        if (errs.length) { r.failed++; console.error("shopify freight tags", channel, pid, errs[0].message); }
        else if (g.want) r.added++; else r.removed++;
      } else r.same++;
      await mark(g.rowIds, g.want);
    } catch (e) {
      r.failed++;
      console.error("shopify freight tags", channel, pid, e);
    }
  }
  return r;
}

async function mark(rowIds: string[], value: boolean) {
  if (!rowIds.length) return;
  await db.execute(sql`update shop_variants set pushed_freight = ${value} where id in (${sql.join(rowIds.map((id) => sql`${id}`), sql`, `)})`);
}

/** Im Hintergrund (nach dem Speichern eines Artikels); Fehler übernimmt der Worker */
export function pushFreightTagsLater(productIds: string[]) {
  if (!productIds.length) return;
  void pushFreightTags({ productIds }).catch((e) => console.error("shopify freight tags later", e));
}
