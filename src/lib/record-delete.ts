import "server-only";
/**
 * Lieferanten, Firmen aus Ausgaben und Kunden löschen (Wunsch Inhaber 17.11.2026: „أي حاجة بتضاف زي الموردين كده يبقى في زرار
 * إن أنا أقدر أحذفها … لو اتضاف بالغلط“) – nur, solange nichts darauf verweist, was bleiben muss:
 * - Lieferant/Firma: Wareneingänge, Ausgaben (Belege, 10 Jahre aufbewahren) und Artikel, bei denen er als Lieferant steht.
 * - Kunde: Angebote, Rechnungen (auch Entwürfe – die kann man selbst löschen), Retouren; ein Konto im Online-Shop (käme beim
 *   nächsten Kunden-Abgleich zurück) und eingeschaltete Großhandelspreise im Shop (sonst bliebe der Kontakt im Shop-Unternehmen).
 * Dieselbe Prüfung für die Anzeige und noch einmal in der Transaktion (Zeile gesperrt); die Fremdschlüssel sind die letzte Sicherung.
 * Vorher-Stand im audit_log (action delete). Nummern werden nicht neu vergeben (Stammdaten, keine Belegnummern).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { withCustomerLock } from "./shopify/customer-lock";

type Q = Pick<typeof db, "execute">;

export class RecordDeleteError extends Error {
  constructor(public code: "notFound" | "used") { super(code); }
}

export type SupplierUsage = { receipts: number; expenses: number; products: number; productList: { id: string; name: string }[] };
export type CustomerUsage = {
  offers: number; invoices: number; drafts: number; draftList: { id: string }[]; returns: number;
  /** Shops, in denen der Kunde ein Konto hat oder bestellt hat (der Abgleich würde ihn wieder anlegen) */
  shopAccounts: string[];
  /** Großhandelspreise im Shop eingeschaltet oder noch verbunden */
  reseller: boolean;
};

export const supplierBlocked = (u: SupplierUsage) => u.receipts + u.expenses + u.products > 0;
export const customerBlocked = (u: CustomerUsage) => u.offers + u.invoices + u.drafts + u.returns > 0 || u.shopAccounts.length > 0 || u.reseller;

export async function supplierUsage(id: string, q: Q = db): Promise<SupplierUsage> {
  const n = (await q.execute<{ receipts: number; expenses: number; products: number }>(sql`select
      (select count(*) from goods_receipts where supplier_id = ${id})::int as receipts,
      (select count(*) from expenses where supplier_id = ${id})::int as expenses,
      (select count(*) from products where supplier_id = ${id})::int as products`)).rows[0];
  const productList = n.products
    ? (await q.execute<{ id: string; name: string }>(sql`select id, name_de as name from products where supplier_id = ${id} order by name_de limit 5`)).rows
    : [];
  return { receipts: n.receipts, expenses: n.expenses, products: n.products, productList };
}

export async function customerUsage(id: string, q: Q = db): Promise<CustomerUsage> {
  const n = (await q.execute<{ offers: number; invoices: number; drafts: number; returns: number; reseller: boolean }>(sql`select
      (select count(*) from offers where customer_id = ${id})::int as offers,
      (select count(*) from invoices where customer_id = ${id} and status <> 'DRAFT')::int as invoices,
      (select count(*) from invoices where customer_id = ${id} and status = 'DRAFT')::int as drafts,
      (select count(*) from returns where customer_id = ${id})::int as returns,
      exists(select 1 from shop_companies where customer_id = ${id} and (wanted or status = 'linked')) as reseller`)).rows[0];
  const draftList = n.drafts
    ? (await q.execute<{ id: string }>(sql`select id from invoices where customer_id = ${id} and status = 'DRAFT' order by created_at desc limit 5`)).rows
    : [];
  const shopAccounts = (await q.execute<{ channel: string }>(sql`select distinct channel from shop_customers
      where customer_id = ${id} and (state = 'ENABLED' or orders > 0) order by channel`)).rows.map((r) => r.channel);
  return { ...n, draftList, shopAccounts };
}

/** Fremdschlüssel verletzt (gleichzeitig ein Beleg angelegt) → wie „wird benutzt“ */
function fkViolation(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23503" || x?.cause?.code === "23503";
}

export async function deleteSupplier(id: string, userId: string) {
  try {
    return await db.transaction(async (tx) => {
      const [s] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id)).for("update");
      if (!s) throw new RecordDeleteError("notFound");
      if (supplierBlocked(await supplierUsage(id, tx))) throw new RecordDeleteError("used");
      await tx.delete(schema.suppliers).where(eq(schema.suppliers.id, id));
      await audit(tx, { entity: "supplier", entityId: id, action: "delete", before: s, userId });
      return s;
    });
  } catch (e) {
    if (fkViolation(e)) throw new RecordDeleteError("used");
    throw e;
  }
}

export async function deleteCustomer(id: string, userId: string) {
  const c0 = await db.query.customers.findFirst({ where: eq(schema.customers.id, id), columns: { email: true } });
  if (!c0) throw new RecordDeleteError("notFound");
  // gleiche Sperre wie der Kunden-Abgleich der Shops (gleiche E-Mail nie gleichzeitig)
  const run = async () => {
    try {
      return await db.transaction(async (tx) => {
        const [c] = await tx.select().from(schema.customers).where(eq(schema.customers.id, id)).for("update");
        if (!c) throw new RecordDeleteError("notFound");
        if (customerBlocked(await customerUsage(id, tx))) throw new RecordDeleteError("used");
        const vatChecks = await tx.select().from(schema.vatChecks).where(eq(schema.vatChecks.customerId, id));
        const shopCompanies = await tx.select().from(schema.shopCompanies).where(eq(schema.shopCompanies.customerId, id));
        const shopCustomers = await tx.select().from(schema.shopCustomers).where(eq(schema.shopCustomers.customerId, id));
        // USt-Prüfungen, Shop-Verknüpfungen per Kaskade; WhatsApp-Chats verlieren nur die Verknüpfung
        await tx.delete(schema.customers).where(eq(schema.customers.id, id));
        await audit(tx, { entity: "customer", entityId: id, action: "delete", before: { customer: c, vatChecks, shopCompanies, shopCustomers }, userId });
        return c;
      });
    } catch (e) {
      if (fkViolation(e)) throw new RecordDeleteError("used");
      throw e;
    }
  };
  return c0.email.trim() ? withCustomerLock(c0.email, run) : run();
}
