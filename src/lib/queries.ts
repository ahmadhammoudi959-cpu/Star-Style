import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { todayIso } from "./dates";
import { soonUntil, type ExpiryFilter } from "./expiry";

export type VariantOption = {
  id: string; productId: string; category: string; sku: string; nameDe: string; nameNl: string; size: string; color: string;
  barcode: string | null; tracksExpiry: boolean; purchasePriceCents: number; stockQty: number; avgCostCents: number;
  imageId: string | null; weightGrams: number | null;
};

/** Alle aktiven Varianten für Auswahllisten (Wareneingang, Verluste, später Verkauf). Einkaufspreis = eigener der Größe/Farbe, sonst des Artikels. */
export async function variantOptions(): Promise<VariantOption[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.product_id, p.category, p.sku, p.name_de, p.name_nl, v.size, v.color, v.barcode, p.tracks_expiry,
           coalesce(nullif(v.purchase_price_cents, 0), p.purchase_price_cents) as purchase_price_cents, v.stock_qty, v.avg_cost_cents, v.weight_grams,
           coalesce(v.image_file_id, p.image_file_id) as image_id
    from variants v join products p on p.id = v.product_id
    where v.active and p.active
    order by p.name_de, v.created_at, v.id`);
  return r.rows.map((x) => ({
    id: String(x.id), productId: String(x.product_id), category: String(x.category ?? ""), sku: String(x.sku), nameDe: String(x.name_de), nameNl: String(x.name_nl),
    size: String(x.size), color: String(x.color), barcode: (x.barcode as string) ?? null, tracksExpiry: Boolean(x.tracks_expiry),
    purchasePriceCents: Number(x.purchase_price_cents), stockQty: Number(x.stock_qty), avgCostCents: Number(x.avg_cost_cents), imageId: (x.image_id as string) ?? null,
    weightGrams: x.weight_grams == null ? null : Number(x.weight_grams),
  }));
}

export type StockRow = VariantOption & {
  minStock: number; reserved: number; category: string; nextExpiry: string | null; valueCents: number;
  /** Stück in Chargen, deren MHD vorbei ist bzw. bald kommt (siehe expiry.ts) */
  expiredQty: number; soonQty: number;
};

/** Kategorien mit Anzahl der Artikel – für die Auswahlliste „Kategorie“ */
export async function productCategories(): Promise<{ name: string; n: number }[]> {
  const r = await db.execute<{ category: string; n: number }>(sql`
    select category, count(*)::int as n from products where active and category <> '' group by category order by category`);
  return r.rows.map((x) => ({ name: x.category, n: Number(x.n) }));
}

export async function stockRows(opts: { q?: string; lowOnly?: boolean; category?: string; expiry?: ExpiryFilter | null; today?: string } = {}): Promise<StockRow[]> {
  const q = opts.q?.trim() ? `%${opts.q.trim().toLowerCase()}%` : null;
  const cat = opts.category?.trim() || null;
  const exp = opts.expiry ?? null;
  const today = opts.today ?? todayIso(), until = soonUntil(today);
  const r = await db.execute<Record<string, unknown>>(sql`
    with stock_list as (
      select v.id, v.product_id, p.sku, p.name_de, p.name_nl, v.size, v.color, v.barcode, p.tracks_expiry,
             coalesce(nullif(v.purchase_price_cents, 0), p.purchase_price_cents) as purchase_price_cents, v.stock_qty, v.avg_cost_cents, v.min_stock, p.category, v.weight_grams,
             coalesce(v.image_file_id, p.image_file_id) as image_id,
             coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0) as reserved,
             (select min(b.expiry_date) from batches b where b.variant_id = v.id and b.qty_left > 0) as next_expiry,
             coalesce((select sum(b.qty_left) from batches b where b.variant_id = v.id and b.qty_left > 0
               and b.expiry_date < ${today}::date), 0)::int as expired_qty,
             coalesce((select sum(b.qty_left) from batches b where b.variant_id = v.id and b.qty_left > 0
               and b.expiry_date >= ${today}::date and b.expiry_date <= ${until}::date), 0)::int as soon_qty
      from variants v join products p on p.id = v.product_id
      where v.active and p.active
        and (${q}::text is null or lower(p.name_de) like ${q} or lower(p.name_nl) like ${q} or lower(p.sku) like ${q} or v.barcode like ${q}
             or lower(p.category) like ${q})
        -- wenig Bestand = wie auf der Startseite: unter dem eigenen Mindestbestand (nur wenn einer eingetragen ist) oder im Minus
        and (${opts.lowOnly ?? false}::boolean = false or (v.min_stock > 0 and v.stock_qty <= v.min_stock) or v.stock_qty < 0)
        and (${cat}::text is null or p.category = ${cat})
    )
    select * from stock_list
    -- MHD-Filter (Startseite „Läuft bald ab“ / „Abgelaufen“): dieselben Chargen wie die Zahlen auf der Startseite
    where ${exp}::text is null or (${exp}::text = 'expired' and expired_qty > 0) or (${exp}::text = 'soon' and soon_qty > 0)
    -- mit MHD-Filter das dringendste zuerst, sonst nach Namen
    order by case when ${exp}::text is null then null else next_expiry end asc nulls last, name_de, size, color`);
  return r.rows.map((x) => {
    const stockQty = Number(x.stock_qty);
    const avg = Number(x.avg_cost_cents);
    return {
      id: String(x.id), productId: String(x.product_id), sku: String(x.sku), nameDe: String(x.name_de), nameNl: String(x.name_nl),
      size: String(x.size), color: String(x.color), barcode: (x.barcode as string) ?? null, tracksExpiry: Boolean(x.tracks_expiry),
      purchasePriceCents: Number(x.purchase_price_cents), stockQty, avgCostCents: avg, imageId: (x.image_id as string) ?? null, minStock: Number(x.min_stock),
      reserved: Number(x.reserved), category: String(x.category), nextExpiry: x.next_expiry ? String(x.next_expiry).slice(0, 10) : null,
      valueCents: Math.max(stockQty, 0) * avg, weightGrams: x.weight_grams == null ? null : Number(x.weight_grams),
      expiredQty: Number(x.expired_qty), soonQty: Number(x.soon_qty),
    };
  });
}

/**
 * Zahlen der Startseite. MHD: „läuft bald ab“ und „abgelaufen“ getrennt (Wunsch Inhaber 12.11.2026), je Anzahl Größen/Farben
 * und Stück – dieselben Regeln wie der Filter in der Lagerliste (stockRows, expiry.ts).
 */
export async function dashboardStats(today = todayIso()) {
  const until = soonUntil(today);
  const r = await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from products where active)::int as products,
      (select coalesce(sum(greatest(stock_qty,0)::bigint * avg_cost_cents),0) from variants where active)::bigint as stock_value,
      (select count(*) from variants v join products p on p.id=v.product_id where v.active and p.active and v.stock_qty <= v.min_stock and v.min_stock > 0)::int as low,
      e.expiring, e.expiring_qty, e.expired, e.expired_qty
    from (
      select count(distinct b.variant_id) filter (where b.expiry_date >= ${today}::date)::int as expiring,
             coalesce(sum(b.qty_left) filter (where b.expiry_date >= ${today}::date), 0)::int as expiring_qty,
             count(distinct b.variant_id) filter (where b.expiry_date < ${today}::date)::int as expired,
             coalesce(sum(b.qty_left) filter (where b.expiry_date < ${today}::date), 0)::int as expired_qty
      from batches b join variants v on v.id = b.variant_id join products p on p.id = v.product_id
      where v.active and p.active and b.qty_left > 0 and b.expiry_date is not null and b.expiry_date <= ${until}::date
    ) e`);
  const x = r.rows[0];
  return {
    products: Number(x.products), stockValueCents: Number(x.stock_value), low: Number(x.low),
    expiring: Number(x.expiring), expiringQty: Number(x.expiring_qty), expired: Number(x.expired), expiredQty: Number(x.expired_qty),
  };
}

export async function alerts(today = todayIso()) {
  const low = await db.execute<Record<string, unknown>>(sql`
    select v.id, p.name_de, v.size, v.color, v.stock_qty, v.min_stock
    from variants v join products p on p.id=v.product_id
    where v.active and p.active and v.min_stock > 0 and v.stock_qty <= v.min_stock
    order by (v.stock_qty::float / nullif(v.min_stock,0)) asc limit 8`);
  // abgelaufene zuerst (ältestes MHD oben), dann die bald ablaufenden
  const exp = await db.execute<Record<string, unknown>>(sql`
    select b.id, v.id as variant_id, p.name_de, v.size, v.color, b.expiry_date, b.qty_left
    from batches b join variants v on v.id=b.variant_id join products p on p.id=v.product_id
    where v.active and p.active and b.qty_left > 0 and b.expiry_date is not null and b.expiry_date <= ${soonUntil(today)}::date
    order by b.expiry_date asc limit 8`);
  return {
    low: low.rows.map((x) => ({ id: String(x.id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)), qty: Number(x.stock_qty), min: Number(x.min_stock) })),
    expiring: exp.rows.map((x) => ({ id: String(x.variant_id), batchId: String(x.id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)), expiry: String(x.expiry_date).slice(0, 10), qty: Number(x.qty_left) })),
  };
}

export function variantLabel(name: string, size: string, color: string) {
  const extra = [size, color].filter(Boolean).join(" · ");
  return extra ? `${name} (${extra})` : name;
}
