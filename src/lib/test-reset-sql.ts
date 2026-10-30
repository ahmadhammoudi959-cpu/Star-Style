/**
 * SQL für „Testdaten löschen“ (Wunsch Inhaber 30.10.2026, einmalig vor dem echten Start).
 * Rein, ohne Abhängigkeiten – die Anweisungen werden genau so auch direkt mit psql getestet.
 *
 * Gelöscht wird: alle Rechnungen (mit Positionen, Raten, Mahnungen), Zahlungen, Angebote (mit Reservierungen),
 * Verluste, Ausgaben, Wareneingänge, Lagerbewegungen und Chargen (Bestand → 0), alle Kunden (Kundennummern ab 1),
 * Nummernkreise (alle Belege wieder ab 0001) und die Dateien dieser Belege.
 * Dazu Testartikel = mit keinem Shop verbunden UND in einem Testbeleg benutzt, und Lieferanten, die nur in
 * Testdaten vorkommen. Shop-Bestellungen werden erst ab dem nächsten Einschalten des Abgleichs übernommen.
 * Bleiben: Artikel aus den Shops, Zuordnungen, Shops, Einstellungen, Benutzer, Protokolle.
 */

/** Testartikel: mit keinem Shop verbunden und in Rechnung, Angebot, Verlust oder Wareneingang benutzt */
const TEST_PRODUCTS = `
  select p.id from products p
  where not exists (select 1 from variants v join shop_variants sv on sv.variant_id = v.id where v.product_id = p.id)
    and exists (select 1 from variants v where v.product_id = p.id and (
         exists (select 1 from invoice_lines x where x.variant_id = v.id)
      or exists (select 1 from offer_lines x where x.variant_id = v.id)
      or exists (select 1 from write_off_lines x where x.variant_id = v.id)
      or exists (select 1 from receipt_lines x where x.variant_id = v.id)))`;

/** Lieferanten, die nur in Testdaten vorkommen (Wareneingang, Ausgabe, Testartikel) und bei keinem anderen Artikel stehen */
const TEST_SUPPLIERS = (testProducts: string) => `
  select s.id from suppliers s
  where (exists (select 1 from goods_receipts g where g.supplier_id = s.id)
      or exists (select 1 from expenses e where e.supplier_id = s.id)
      or exists (select 1 from products p where p.supplier_id = s.id and p.id in (select id from ${testProducts})))
    and not exists (select 1 from products p where p.supplier_id = s.id and p.id not in (select id from ${testProducts}))`;

/** Sperren: „live“ = Echtbetrieb hat begonnen (Monat abgeschlossen, Mappe an Steuerberater, Shop-Bestellung) → nie mehr */
export const STATUS_SQL = `
  select
    (exists (select 1 from period_locks) or exists (select 1 from advisor_exports)
      or exists (select 1 from invoices where channel <> 'STORE')) as live,
    exists (select 1 from shops where active) as sync_on`;

/** Vorschau: was gelöscht würde (Zahlen + Namen). Auch in der Transaktion zum Vergleich mit dem, was der Nutzer gesehen hat. */
export const PREVIEW_SQL = `
  with tp as (${TEST_PRODUCTS}), ts as (${TEST_SUPPLIERS("tp")})
  select
    (select count(*) from invoices where kind = 'INVOICE' and status <> 'DRAFT')::int as invoices,
    (select count(*) from invoices where kind = 'CANCELLATION')::int as cancellations,
    (select count(*) from invoices where status = 'DRAFT')::int as drafts,
    (select count(*) from offers)::int as offers,
    (select count(*) from payments)::int as payments,
    (select count(*) from goods_receipts)::int as receipts,
    (select count(*) from write_offs)::int as write_offs,
    (select count(*) from expenses)::int as expenses,
    (select count(*) from customers)::int as customers,
    (select coalesce(sum(stock_qty) filter (where stock_qty > 0), 0) from variants)::int as units,
    (select count(*) from variants where stock_qty <> 0)::int as stocked,
    (select coalesce(json_agg(c.name order by c.number), '[]'::json) from customers c) as customer_names,
    (select coalesce(json_agg(p.name_de order by p.name_de), '[]'::json) from products p where p.id in (select id from tp)) as products,
    (select coalesce(json_agg(s.name order by s.name), '[]'::json) from suppliers s where s.id in (select id from ts)) as suppliers,
    (select coalesce(json_agg(n order by n), '[]'::json) from (
       select number as n from invoices where number is not null union all select number from offers
       union all select number from payments union all select number from goods_receipts union all select number from write_offs) d) as numbers`;

/** Zuerst in der Transaktion: gleichzeitige Belegnummern warten, bis wir fertig sind */
export const RESET_LOCK = `lock table number_sequences in exclusive mode`;

/** Die Löschung – in genau dieser Reihenfolge, in derselben Transaktion nach RESET_LOCK und der Prüfung */
export const RESET_STATEMENTS: string[] = [
  `create temp table _reset_products on commit drop as ${TEST_PRODUCTS}`,
  `create temp table _reset_suppliers on commit drop as ${TEST_SUPPLIERS("_reset_products")}`,
  // Dateien der gelöschten Belege und Testartikel (werden am Ende entfernt, wenn sonst niemand sie benutzt)
  `create temp table _reset_files on commit drop as
     select pdf_file_id as id from invoices where pdf_file_id is not null
     union select export_proof_file_id from invoices where export_proof_file_id is not null
     union select photo_file_id from write_offs where photo_file_id is not null
     union select file_id from expenses where file_id is not null
     union select image_file_id from products where image_file_id is not null and id in (select id from _reset_products)
     union select image_file_id from variants where image_file_id is not null and product_id in (select id from _reset_products)`,
  // Shops sollen den neuen Bestand (0) erfahren, sobald der Abgleich läuft
  `insert into stock_dirty (variant_id)
     select id from variants where stock_qty <> 0 and product_id not in (select id from _reset_products)
     on conflict (variant_id) do update set at = now()`,
  `delete from stock_dirty where variant_id in (select id from variants where product_id in (select id from _reset_products))`,
  `delete from payments`,
  `delete from invoices`, // + Positionen, Raten, Mahnungen (Kaskade)
  `delete from offers`, // + Positionen, Reservierungen
  `delete from write_offs`, // + Positionen
  `delete from expenses`,
  `delete from goods_receipts`, // + Positionen
  `delete from stock_movements`,
  `delete from batches`,
  `update variants set stock_qty = 0, avg_cost_cents = 0 where stock_qty <> 0 or avg_cost_cents <> 0`,
  `delete from customers`, // + USt-IdNr.-Prüfungen
  `select setval(pg_get_serial_sequence('customers', 'number'), 1, false)`,
  `delete from products where id in (select id from _reset_products)`, // + Varianten
  `delete from suppliers where id in (select id from _reset_suppliers)`,
  `delete from number_sequences`,
  // Shop-Bestellungen erst ab dem nächsten Einschalten des Abgleichs übernehmen (vorher lief der Verkauf ohne uns)
  `update shops set orders_since = null, last_order_sync = null`,
  `delete from stored_files f where f.id in (select id from _reset_files)
     and not exists (select 1 from products where image_file_id = f.id)
     and not exists (select 1 from variants where image_file_id = f.id)
     and not exists (select 1 from company_settings where logo_file_id = f.id)
     and not exists (select 1 from advisor_exports where file_id = f.id)`,
];

export type ResetPreview = {
  invoices: number; cancellations: number; drafts: number; offers: number; payments: number; receipts: number;
  writeOffs: number; expenses: number; customers: number; units: number; stocked: number;
  customerNames: string[]; products: string[]; suppliers: string[]; numbers: string[];
};

export function toPreview(r: Record<string, unknown>): ResetPreview {
  const n = (k: string) => Number(r[k] ?? 0);
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : typeof r[k] === "string" ? (JSON.parse(r[k] as string) as unknown[]).map(String) : []);
  return {
    invoices: n("invoices"), cancellations: n("cancellations"), drafts: n("drafts"), offers: n("offers"), payments: n("payments"),
    receipts: n("receipts"), writeOffs: n("write_offs"), expenses: n("expenses"), customers: n("customers"), units: n("units"), stocked: n("stocked"),
    customerNames: list("customer_names"), products: list("products"), suppliers: list("suppliers"), numbers: list("numbers"),
  };
}

/** Kurzer Fingerabdruck: hat sich seit der Anzeige etwas geändert? */
export function fingerprint(p: ResetPreview): string {
  return [p.invoices, p.cancellations, p.drafts, p.offers, p.payments, p.receipts, p.writeOffs, p.expenses, p.customers, p.units, p.stocked,
    p.products.length, p.suppliers.length, p.numbers.length].join(".");
}

export function isEmpty(p: ResetPreview): boolean {
  return !(p.invoices || p.cancellations || p.drafts || p.offers || p.payments || p.receipts || p.writeOffs || p.expenses
    || p.customers || p.stocked || p.products.length || p.suppliers.length);
}
