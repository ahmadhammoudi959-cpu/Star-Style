import "server-only";
/**
 * Versandart aus der Datenbank (Wunsch Inhaber 19.11.2026): Spedition ja/nein je Artikel – Regeln rein in ./shipping-class.ts.
 * Benutzt vom Tag-Abgleich mit den Shops (./shopify/freight-tags.ts) und beim GLS-Etikett (./shipments.ts: Möbel nie mit GLS).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dimsOf, productShipping, type ShippingClass } from "./shipping-class";

type ClassRow = {
  product_id: string; shipping_class: string | null; weight_grams: number | null;
  pkg_length_mm: number | null; pkg_width_mm: number | null; pkg_height_mm: number | null;
};

/** Spedition ja/nein je Artikel (alle aktiven Größen/Farben; feste Einstellung am Artikel geht vor) */
export async function freightByProduct(productIds?: string[]): Promise<Map<string, boolean>> {
  if (productIds && !productIds.length) return new Map();
  const rows = (await db.execute<ClassRow>(sql`
    select p.id as product_id, p.shipping_class, v.weight_grams, v.pkg_length_mm, v.pkg_width_mm, v.pkg_height_mm
    from products p left join variants v on v.product_id = p.id and v.active
    ${productIds ? sql`where p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`)).rows;
  const by = new Map<string, { mode: ShippingClass | null; vs: { weightGrams: number | null; dims: ReturnType<typeof dimsOf> }[] }>();
  for (const r of rows) {
    const e = by.get(r.product_id) ?? { mode: r.shipping_class === "PARCEL" || r.shipping_class === "FREIGHT" ? r.shipping_class : null, vs: [] };
    if (r.weight_grams != null || r.pkg_length_mm != null)
      e.vs.push({ weightGrams: r.weight_grams, dims: dimsOf({ pkgLengthMm: r.pkg_length_mm, pkgWidthMm: r.pkg_width_mm, pkgHeightMm: r.pkg_height_mm }) });
    by.set(r.product_id, e);
  }
  return new Map([...by].map(([id, e]) => [id, productShipping(e.mode, e.vs).cls === "FREIGHT"]));
}
