import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export type VariantOption = {
  id: string; productId: string; sku: string; nameDe: string; nameNl: string; size: string; color: string;
  barcode: string | null; tracksExpiry: boolean; purchasePriceCents: number; stockQty: number; avgCostCents: number;
};

/** Alle aktiven Varianten für Auswahllisten (Wareneingang, Verluste, später Verkauf). */
export async function variantOptions(): Promise<VariantOption[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.product_id, p.sku, p.name_de, p.name_nl, v.size, v.color, v.barcode, p.tracks_expiry,
           p.purchase_price_cents, v.stock_qty, v.avg_cost_cents
    from variants v join products p on p.id = v.product_id
    where v.active and p.active
    order by p.name_de, v.size, v.color`);
  return r.rows.map((x) => ({
    id: String(x.id), productId: String(x.product_id), sku: String(x.sku), nameDe: String(x.name_de), nameNl: String(x.name_nl),
    size: String(x.size), color: String(x.color), barcode: (x.barcode as string) ?? null, tracksExpiry: Boolean(x.tracks_expiry),
    purchasePriceCents: Number(x.purchase_price_cents), stockQty: Number(x.stock_qty), avgCostCents: Number(x.avg_cost_cents),
  }));
}

export type StockRow = VariantOption & {
  minStock: number; reserved: number; category: string; nextExpiry: string | null; valueCents: number;
};

export async function stockRows(opts: { q?: string; lowOnly?: boolean } = {}): Promise<StockRow[]> {
  const q = opts.q?.trim() ? `%${opts.q.trim().toLowerCase()}%` : null;
  const r = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.product_id, p.sku, p.name_de, p.name_nl, v.size, v.color, v.barcode, p.tracks_expiry,
           p.purchase_price_cents, v.stock_qty, v.avg_cost_cents, v.min_stock, p.category,
           coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0) as reserved,
           (select min(b.expiry_date) from batches b where b.variant_id = v.id and b.qty_left > 0) as next_expiry
    from variants v join products p on p.id = v.product_id
    where v.active and p.active
      and (${q}::text is null or lower(p.name_de) like ${q} or lower(p.name_nl) like ${q} or lower(p.sku) like ${q} or v.barcode like ${q})
      and (${opts.lowOnly ?? false}::boolean = false or v.stock_qty <= v.min_stock)
    order by p.name_de, v.size, v.color`);
  return r.rows.map((x) => {
    const stockQty = Number(x.stock_qty);
    const avg = Number(x.avg_cost_cents);
    return {
      id: String(x.id), productId: String(x.product_id), sku: String(x.sku), nameDe: String(x.name_de), nameNl: String(x.name_nl),
      size: String(x.size), color: String(x.color), barcode: (x.barcode as string) ?? null, tracksExpiry: Boolean(x.tracks_expiry),
      purchasePriceCents: Number(x.purchase_price_cents), stockQty, avgCostCents: avg, minStock: Number(x.min_stock),
      reserved: Number(x.reserved), category: String(x.category), nextExpiry: (x.next_expiry as string) ?? null,
      valueCents: Math.max(stockQty, 0) * avg,
    };
  });
}

export async function dashboardStats() {
  const r = await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from products where active)::int as products,
      (select coalesce(sum(greatest(stock_qty,0)::bigint * avg_cost_cents),0) from variants where active)::bigint as stock_value,
      (select count(*) from variants v join products p on p.id=v.product_id where v.active and p.active and v.stock_qty <= v.min_stock and v.min_stock > 0)::int as low,
      (select count(distinct variant_id) from batches where qty_left > 0 and expiry_date is not null and expiry_date <= (current_date + 60))::int as expiring`);
  const x = r.rows[0];
  return { products: Number(x.products), stockValueCents: Number(x.stock_value), low: Number(x.low), expiring: Number(x.expiring) };
}

export async function alerts() {
  const low = await db.execute<Record<string, unknown>>(sql`
    select v.id, p.name_de, v.size, v.color, v.stock_qty, v.min_stock
    from variants v join products p on p.id=v.product_id
    where v.active and p.active and v.min_stock > 0 and v.stock_qty <= v.min_stock
    order by (v.stock_qty::float / nullif(v.min_stock,0)) asc limit 8`);
  const exp = await db.execute<Record<string, unknown>>(sql`
    select b.id, v.id as variant_id, p.name_de, v.size, v.color, b.expiry_date, b.qty_left
    from batches b join variants v on v.id=b.variant_id join products p on p.id=v.product_id
    where b.qty_left > 0 and b.expiry_date is not null and b.expiry_date <= (current_date + 60)
    order by b.expiry_date asc limit 8`);
  return {
    low: low.rows.map((x) => ({ id: String(x.id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)), qty: Number(x.stock_qty), min: Number(x.min_stock) })),
    expiring: exp.rows.map((x) => ({ id: String(x.variant_id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)), expiry: String(x.expiry_date), qty: Number(x.qty_left) })),
  };
}

export function variantLabel(name: string, size: string, color: string) {
  const extra = [size, color].filter(Boolean).join(" · ");
  return extra ? `${name} (${extra})` : name;
}
