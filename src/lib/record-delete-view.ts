/**
 * Gründe für „Löschen nicht möglich“ in der Sprache des Nutzers (Lieferant/Firma aus Ausgaben/Kunde) – mit Links zu dem,
 * was man vorher ändern kann (Artikel mit diesem Lieferanten, Rechnungsentwürfe).
 */
import { fill, type Dict } from "@/i18n";
import type { CustomerUsage, SupplierUsage } from "./record-delete";
import type { DeleteBlock } from "@/components/DeleteRecord";

export function supplierBlocks(t: Dict, u: SupplierUsage): DeleteBlock[] {
  const out: DeleteBlock[] = [];
  if (u.receipts) out.push({ text: fill(t.remove.receipts, { n: u.receipts }) });
  if (u.expenses) out.push({ text: fill(t.remove.expenses, { n: u.expenses }) });
  if (u.products) out.push({
    text: fill(t.remove.products, { n: u.products }),
    links: [...u.productList.map((p) => ({ href: `/products/${p.id}`, label: p.name })), ...(u.products > u.productList.length ? [{ href: "/products", label: "…" }] : [])],
  });
  return out;
}

export function customerBlocks(t: Dict, u: CustomerUsage, box: string): DeleteBlock[] {
  const out: DeleteBlock[] = [];
  if (u.offers) out.push({ text: fill(t.remove.offers, { n: u.offers }) });
  if (u.invoices) out.push({ text: fill(t.remove.invoices, { n: u.invoices }) });
  if (u.returns) out.push({ text: fill(t.remove.returns, { n: u.returns }) });
  if (u.drafts) out.push({ text: fill(t.remove.drafts, { n: u.drafts }), links: u.draftList.map((d, i) => ({ href: `/sales/invoices/${d.id}`, label: `${t.sales.status.DRAFT} ${i + 1}` })) });
  if (u.shopAccounts.length) out.push({ text: fill(t.remove.shopAccount, { shops: u.shopAccounts.map((c) => t.shop.names[c as keyof Dict["shop"]["names"]] ?? c).join(", ") }) });
  if (u.reseller) out.push({ text: fill(t.remove.reseller, { box }) });
  return out;
}

/** Belege dabei → Hinweis „10 Jahre aufbewahren“ */
export const supplierHasDocs = (u: SupplierUsage) => u.receipts + u.expenses > 0;
export const customerHasDocs = (u: CustomerUsage) => u.offers + u.invoices + u.returns > 0;
