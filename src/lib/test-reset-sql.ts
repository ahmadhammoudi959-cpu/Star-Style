/**
 * SQL für „System zurücksetzen“ = Start des Echtbetriebs (Wunsch Inhaber 30.10.2026, geändert 04.11.2026). Einmalig.
 * Rein, ohne Abhängigkeiten – die Anweisungen werden genau so auch direkt mit psql getestet.
 *
 * Gelöscht werden alle Bewegungen und Vorgänge: alle Rechnungen (mit Positionen, Raten, Mahnungen), Zahlungen, Angebote
 * (mit Reservierungen), Verluste, Ausgaben, Wareneingänge, Lagerbewegungen und Chargen (Bestand → 0), alle Kunden
 * (Kundennummern ab 1), Nummernkreise (alle Belege wieder ab 0001), Monatsmappen für den Steuerberater (aus der Testzeit),
 * die Dateien dieser Belege und Lieferanten, die nur in diesen Vorgängen vorkommen und bei keinem Artikel stehen.
 * Bleiben: ALLE Artikel so, wie sie sind (Namen, Preise, Größen/Farben, Barcodes, Fotos, Shop-Galerien, Zuordnungen zu den
 * Shops, Kategorien), die Lieferanten der Artikel, Shops, Einstellungen, Benutzer, Protokolle.
 * Zum Schluss company_settings.live_since = jetzt: ab da Echtbetrieb, nie mehr zurücksetzen (Anzeige „Echtbetrieb seit …“).
 * Shop-Bestellungen werden erst ab dem nächsten Einschalten des Abgleichs übernommen.
 */

/** Lieferanten, die nur in den gelöschten Vorgängen vorkommen (Wareneingang, Ausgabe) und bei keinem Artikel stehen */
const DOC_ONLY_SUPPLIERS = `
  select s.id from suppliers s
  where (exists (select 1 from goods_receipts g where g.supplier_id = s.id)
      or exists (select 1 from expenses e where e.supplier_id = s.id))
    and not exists (select 1 from products p where p.supplier_id = s.id)`;

/**
 * Sperren: „live“ = Echtbetrieb → nie mehr: schon zurückgesetzt (live_since) oder ein Monat abgeschlossen (kann der Nutzer
 * selbst wieder öffnen). Eine Shop-Bestellung oder eine Monatsmappe allein zählt nicht – vor dem Start sind das Tests
 * (Wunsch Inhaber 04.11.2026: Testbestellung #1002, Test-Monatsmappe November); die Mappen werden mit gelöscht.
 */
export const STATUS_SQL = `
  select
    (exists (select 1 from company_settings where live_since is not null) or exists (select 1 from period_locks)) as live,
    exists (select 1 from shops where active) as sync_on,
    (select max(live_since) from company_settings) as live_since`;

/** Vorschau: was gelöscht würde (Zahlen + Namen + Prüfsumme der IDs). Auch in der Transaktion zum Vergleich mit dem, was der Nutzer gesehen hat. */
export const PREVIEW_SQL = `
  with ds as (${DOC_ONLY_SUPPLIERS})
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
    (select count(*) from number_sequences)::int as sequences,
    (select count(*) from advisor_exports)::int as exports,
    (select count(*) from products)::int as products_kept,
    (select coalesce(json_agg(c.name order by c.number), '[]'::json) from customers c) as customer_names,
    (select coalesce(json_agg(s.name order by s.name), '[]'::json) from suppliers s where s.id in (select id from ds)) as suppliers,
    (select coalesce(json_agg(n order by n), '[]'::json) from (
       select number as n from invoices where number is not null union all select number from offers
       union all select number from payments union all select number from goods_receipts union all select number from write_offs) d) as numbers,
    md5(concat_ws('#',
      's:' || coalesce((select string_agg(id, ',' order by id) from ds), ''),
      'c:' || coalesce((select string_agg(id, ',' order by id) from customers), ''),
      'i:' || coalesce((select string_agg(id, ',' order by id) from invoices), ''),
      'o:' || coalesce((select string_agg(id, ',' order by id) from offers), ''),
      'q:' || coalesce((select string_agg(id, ',' order by id) from payments), ''),
      'g:' || coalesce((select string_agg(id, ',' order by id) from goods_receipts), ''),
      'w:' || coalesce((select string_agg(id, ',' order by id) from write_offs), ''),
      'e:' || coalesce((select string_agg(id, ',' order by id) from expenses), ''),
      'x:' || coalesce((select string_agg(id, ',' order by id) from advisor_exports), ''),
      'v:' || coalesce((select string_agg(id || ':' || stock_qty::text, ',' order by id) from variants where stock_qty <> 0), ''),
      'n:' || coalesce((select string_agg(kind::text || '-' || year::text || ':' || next::text, ',' order by kind, year) from number_sequences), '')
    )) as digest`;

/** Zuerst in der Transaktion: gleichzeitige Belegnummern warten, bis wir fertig sind */
export const RESET_LOCK = `lock table number_sequences in exclusive mode`;

/** Die Löschung – in genau dieser Reihenfolge, in derselben Transaktion nach RESET_LOCK und der Prüfung */
export const RESET_STATEMENTS: string[] = [
  `create temp table _reset_suppliers on commit drop as ${DOC_ONLY_SUPPLIERS}`,
  // Dateien der gelöschten Belege (werden am Ende entfernt, wenn sonst niemand sie benutzt); Artikel-Fotos bleiben
  `create temp table _reset_files on commit drop as
     select pdf_file_id as id from invoices where pdf_file_id is not null
     union select export_proof_file_id from invoices where export_proof_file_id is not null
     union select photo_file_id from write_offs where photo_file_id is not null
     union select file_id from expenses where file_id is not null
     union select file_id from advisor_exports`,
  // kein Shop läuft (geprüft); beim Einschalten gleicht der Abgleich ohnehin alle Bestände ab
  `delete from stock_dirty`,
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
  `delete from suppliers where id in (select id from _reset_suppliers)`,
  `delete from number_sequences`,
  `delete from advisor_exports`, // Test-Monatsmappen (ZIP-Dateien unten mit weg)
  // Shop-Bestellungen erst ab dem nächsten Einschalten des Abgleichs übernehmen (vorher lief der Verkauf ohne uns)
  `update shops set orders_since = null, last_order_sync = null`,
  `delete from stored_files f where f.id in (select id from _reset_files)
     and not exists (select 1 from products where image_file_id = f.id)
     and not exists (select 1 from variants where image_file_id = f.id)
     and not exists (select 1 from shop_media where file_id = f.id)
     and not exists (select 1 from company_settings where logo_file_id = f.id)
     and not exists (select 1 from advisor_exports where file_id = f.id)`,
  // ab jetzt Echtbetrieb – kein Zurücksetzen mehr
  `update company_settings set live_since = now()`,
];

export type ResetPreview = {
  invoices: number; cancellations: number; drafts: number; offers: number; payments: number; receipts: number;
  writeOffs: number; expenses: number; customers: number; units: number; stocked: number; sequences: number; exports: number;
  /** bleiben alle (nur zur Anzeige) */
  productsKept: number;
  customerNames: string[]; suppliers: string[]; numbers: string[]; digest: string;
};

export function toPreview(r: Record<string, unknown>): ResetPreview {
  const n = (k: string) => Number(r[k] ?? 0);
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : typeof r[k] === "string" ? (JSON.parse(r[k] as string) as unknown[]).map(String) : []);
  return {
    invoices: n("invoices"), cancellations: n("cancellations"), drafts: n("drafts"), offers: n("offers"), payments: n("payments"),
    receipts: n("receipts"), writeOffs: n("write_offs"), expenses: n("expenses"), customers: n("customers"), units: n("units"),
    stocked: n("stocked"), sequences: n("sequences"), exports: n("exports"), productsKept: n("products_kept"),
    customerNames: list("customer_names"), suppliers: list("suppliers"), numbers: list("numbers"),
    digest: String(r.digest ?? ""),
  };
}

/** Fingerabdruck: Zahlen + Prüfsumme der betroffenen IDs – ändert sich, sobald etwas anderes gelöscht würde als angezeigt */
export function fingerprint(p: ResetPreview): string {
  return [p.invoices, p.cancellations, p.drafts, p.offers, p.payments, p.receipts, p.writeOffs, p.expenses, p.customers, p.units, p.stocked,
    p.sequences, p.exports, p.suppliers.length, p.numbers.length, p.digest].join(".");
}

/** Nichts zu löschen (dann startet der Knopf nur den Echtbetrieb) */
export function isEmpty(p: ResetPreview): boolean {
  return !(p.invoices || p.cancellations || p.drafts || p.offers || p.payments || p.receipts || p.writeOffs || p.expenses
    || p.customers || p.stocked || p.sequences || p.exports || p.suppliers.length);
}
