import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CustomerOpt, SaleOption } from "@/app/(app)/sales/DocEditor";
import { customerOpenBalances } from "./receivables";

export async function customerOptions(): Promise<CustomerOpt[]> {
  const [rows, open] = await Promise.all([
    db.select().from(schema.customers).where(eq(schema.customers.active, true)).orderBy(asc(schema.customers.name)),
    customerOpenBalances(),
  ]);
  return rows.map((c) => ({
    id: c.id, number: c.number, name: c.name, city: c.city, type: c.type, country: c.country, vatIdStatus: c.vatIdStatus, priceGroup: c.priceGroup,
    openCents: open.get(c.id) ?? 0, creditLimitCents: c.creditLimitCents,
  }));
}

/** Verkaufbare Varianten mit Preisen und Verfügbarkeit (ohne die Reservierungen des eigenen Angebots). */
export async function saleOptions(ownOfferId?: string): Promise<SaleOption[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    select v.id, p.sku, p.name_de, p.name_nl, v.size, v.color, v.barcode, v.stock_qty, p.vat_rate_bp,
           coalesce(v.image_file_id, p.image_file_id) as image_id,
           coalesce(v.wholesale_price_cents, p.wholesale_price_cents) as wholesale, coalesce(v.retail_price_cents, p.retail_price_cents) as retail,
           v.stock_qty - coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()
             ${ownOfferId ? sql`and r.offer_id <> ${ownOfferId}` : sql``}), 0) as available
    from variants v join products p on p.id = v.product_id
    where v.active and p.active order by p.name_de, v.size, v.color`);
  return r.rows.map((x) => ({
    id: String(x.id), sku: String(x.sku), nameDe: String(x.name_de), nameNl: String(x.name_nl), size: String(x.size), color: String(x.color),
    barcode: (x.barcode as string) ?? null, stockQty: Number(x.available), wholesalePriceCents: Number(x.wholesale), retailPriceCents: Number(x.retail),
    vatRateBp: Number(x.vat_rate_bp), available: Number(x.available), imageId: (x.image_id as string) ?? null,
  }));
}
