import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Erste Schritte (nummeriert) – gilt als erledigt, sobald die passenden Daten existieren. */
export const STEP_KEYS = ["company", "supplier", "product", "receive", "customer", "invoice", "payment"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const STEP_HREF: Record<StepKey, string> = {
  company: "/settings", supplier: "/suppliers/new", product: "/products/new", receive: "/receive",
  customer: "/customers/new", invoice: "/sales/invoices/new", payment: "/receivables",
};
/** Menüpunkt, an dem die Nummer angezeigt wird */
export const STEP_NAV: Record<StepKey, string> = {
  company: "/settings", supplier: "/suppliers", product: "/products", receive: "/receive",
  customer: "/customers", invoice: "/sales", payment: "/receivables",
};

export async function setupSteps() {
  const r = (await db.execute<Record<string, unknown>>(sql`select
      (select (coalesce(street,'') <> '' and coalesce(city,'') <> '' and (coalesce(vat_id,'') <> '' or coalesce(tax_number,'') <> '') and coalesce(iban,'') <> '')
         from company_settings limit 1) as company,
      exists(select 1 from suppliers) as supplier,
      exists(select 1 from products) as product,
      exists(select 1 from goods_receipts) as receive,
      exists(select 1 from customers) as customer,
      exists(select 1 from invoices where number is not null and kind = 'INVOICE') as invoice,
      exists(select 1 from payments) as payment,
      coalesce((select show_guide from company_settings limit 1), false) as show_guide`)).rows[0] ?? {};
  const steps = STEP_KEYS.map((key, i) => ({ key, n: i + 1, href: STEP_HREF[key], nav: STEP_NAV[key], done: Boolean(r[key]) }));
  const next = steps.find((s) => !s.done)?.key ?? null;
  // allDone = Anleitung ausblenden: alles erledigt UND nicht in den Einstellungen dauerhaft eingeschaltet
  return { steps, next, doneCount: steps.filter((s) => s.done).length, allDone: !next && !r.show_guide, showGuide: Boolean(r.show_guide) };
}
