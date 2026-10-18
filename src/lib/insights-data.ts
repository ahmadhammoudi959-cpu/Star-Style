import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { todayIso, addDaysIso } from "./dates";
import { variantLabel } from "./queries";
import { expiryRisks, reorderSuggestions, slowMovers, WINDOW_DAYS, type BatchItem, type StockItem } from "./insights";

type Row = Record<string, unknown>;

export async function loadStockItems(): Promise<StockItem[]> {
  const since = addDaysIso(todayIso(), -WINDOW_DAYS);
  const r = await db.execute<Row>(sql`
    select v.id, p.name_de, v.size, v.color, p.sku, p.supplier_id, coalesce(s.name, '') as supplier,
      v.stock_qty, v.min_stock, greatest(v.avg_cost_cents, 0) as avg_cost, p.purchase_price_cents,
      coalesce((select sum(qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0)::int as reserved,
      coalesce((select -sum(m.qty) from stock_movements m where m.variant_id = v.id and m.ref_type = 'invoice'
        and m.type in ('SALE', 'CANCEL') and m.created_at >= ${since}::date), 0)::int as sold,
      (select max(received_at)::date from batches b where b.variant_id = v.id) as last_receipt
    from variants v join products p on p.id = v.product_id left join suppliers s on s.id = p.supplier_id
    where v.active and p.active`);
  return r.rows.map((x) => ({
    variantId: String(x.id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)), sku: String(x.sku),
    supplierId: x.supplier_id ? String(x.supplier_id) : null, supplierName: String(x.supplier),
    stock: Number(x.stock_qty), reserved: Number(x.reserved), minStock: Number(x.min_stock), sold: Math.max(0, Number(x.sold)),
    unitCostCents: Number(x.purchase_price_cents) || Number(x.avg_cost), lastReceipt: x.last_receipt ? String(x.last_receipt).slice(0, 10) : null,
  }));
}

export async function loadInsights() {
  const today = todayIso();
  const items = await loadStockItems();
  const b = await db.execute<Row>(sql`
    select b.id, b.variant_id, p.name_de, v.size, v.color, b.expiry_date, b.qty_left, b.unit_cost_cents
    from batches b join variants v on v.id = b.variant_id join products p on p.id = v.product_id
    where b.qty_left > 0 and b.expiry_date is not null and b.expiry_date <= ${addDaysIso(today, 120)}::date`);
  const batches: BatchItem[] = b.rows.map((x) => ({
    batchId: String(x.id), variantId: String(x.variant_id), name: variantLabel(String(x.name_de), String(x.size), String(x.color)),
    expiry: String(x.expiry_date).slice(0, 10), qtyLeft: Number(x.qty_left), unitCostCents: Number(x.unit_cost_cents),
  }));
  const perDay = new Map(items.map((i) => [i.variantId, i.sold / WINDOW_DAYS]));
  return {
    reorder: reorderSuggestions(items),
    expiry: expiryRisks(batches, perDay, today),
    slow: slowMovers(items, today),
  };
}
export type Insights = Awaited<ReturnType<typeof loadInsights>>;
