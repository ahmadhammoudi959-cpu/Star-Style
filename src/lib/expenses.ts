/**
 * Eingangsrechnungen / Ausgaben.
 * Lieferant wird automatisch angelegt, wenn der Name neu ist (z. B. „Meta Platforms Ireland“).
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { assertOpen } from "./periods";
import { daysBetween } from "./dates";
import { expenseAmounts, type ExpenseCategory, type ExpenseTaxCase, type PayMethod } from "./accounts";

export class ExpenseError extends Error {
  constructor(public code: string) { super(code); }
}

export type ExpenseInput = {
  id?: string;
  date: string; vendorName: string; vendorCountry: string; vendorVatId: string; invoiceNo: string;
  category: ExpenseCategory; taxCase: ExpenseTaxCase; channel: "BRAND_SHOP" | "GENERAL_SHOP" | "STORE" | null;
  amountCents: number; vatRateBp: number;
  paid: boolean; paidAt: string | null; paymentMethod: PayMethod | null;
  fileId?: string | null; note: string;
};

export function validateExpense(e: ExpenseInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new ExpenseError("date");
  if (!e.vendorName.trim()) throw new ExpenseError("vendor");
  if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) throw new ExpenseError("amount");
  if (![0, 700, 1900].includes(e.vatRateBp)) throw new ExpenseError("rate");
  if (e.category === "GOODS" && (e.taxCase === "EU_SERVICE" || e.taxCase === "NON_EU_SERVICE")) throw new ExpenseError("goodsService");
  if ((e.taxCase === "EU_SERVICE" || e.taxCase === "NON_EU_SERVICE" || e.taxCase === "EU_GOODS") && e.vatRateBp === 0) throw new ExpenseError("rcRate");
  if (e.taxCase === "EU_GOODS" && !e.vendorVatId.trim()) throw new ExpenseError("vatIdRequired");
  if (e.paid && (!e.paidAt || !e.paymentMethod)) throw new ExpenseError("paidInfo");
  // Vorauszahlung erlaubt, aber höchstens 31 Tage vor dem Rechnungsdatum – fängt Tippfehler ab
  if (e.paid && daysBetween(e.paidAt!, e.date) > 31) throw new ExpenseError("paidDate");
}

export async function saveExpense(e: ExpenseInput, userId?: string): Promise<string> {
  validateExpense(e);
  const amounts = expenseAmounts(e.taxCase, e.amountCents, e.vatRateBp);
  return db.transaction(async (tx) => {
    const before = e.id ? await tx.query.expenses.findFirst({ where: eq(schema.expenses.id, e.id) }) : null;
    if (e.id && !before) throw new ExpenseError("notFound");
    try {
      await assertOpen(tx, e.date, e.paid ? e.paidAt : null, before?.date, before?.paid ? before.paidAt : null);
    } catch { throw new ExpenseError("periodLocked"); }

    // Lieferant finden oder anlegen
    const name = e.vendorName.trim();
    let supplier = await tx.query.suppliers.findFirst({ where: sql`lower(${schema.suppliers.name}) = lower(${name})` });
    const vatId = e.vendorVatId.replace(/\s/g, "").toUpperCase();
    if (!supplier) {
      [supplier] = await tx.insert(schema.suppliers).values({ name, country: e.vendorCountry.toUpperCase(), vatId }).returning();
      await audit(tx, { entity: "supplier", entityId: supplier.id, action: "create", after: supplier, userId });
    } else if ((vatId && supplier.vatId !== vatId) || supplier.country !== e.vendorCountry.toUpperCase()) {
      await tx.update(schema.suppliers).set({ vatId: vatId || supplier.vatId, country: e.vendorCountry.toUpperCase() }).where(eq(schema.suppliers.id, supplier.id));
    }

    const values = {
      date: e.date, supplierId: supplier.id, vendorName: supplier.name, vendorCountry: e.vendorCountry.toUpperCase(), invoiceNo: e.invoiceNo.trim(),
      category: e.category, taxCase: e.taxCase, channel: e.channel, vatRateBp: e.vatRateBp,
      netCents: amounts.netCents, vatCents: amounts.vatCents, grossCents: amounts.grossCents,
      reverseCharge: e.taxCase === "EU_SERVICE" || e.taxCase === "NON_EU_SERVICE",
      paid: e.paid, paidAt: e.paid ? e.paidAt : null, paymentMethod: e.paid ? e.paymentMethod : null,
      fileId: e.fileId === undefined ? before?.fileId ?? null : e.fileId, note: e.note.trim(),
    };
    if (before) {
      const [row] = await tx.update(schema.expenses).set(values).where(eq(schema.expenses.id, before.id)).returning();
      await audit(tx, { entity: "expense", entityId: row.id, action: "update", before, after: row, userId });
      return row.id;
    }
    // Doppelte Erfassung verhindern (gleicher Lieferant + gleiche Rechnungsnummer)
    if (values.invoiceNo) {
      const dup = await tx.query.expenses.findFirst({ where: and(eq(schema.expenses.supplierId, supplier.id), eq(schema.expenses.invoiceNo, values.invoiceNo)) });
      if (dup) throw new ExpenseError("duplicate");
    }
    const [row] = await tx.insert(schema.expenses).values(values).returning();
    await audit(tx, { entity: "expense", entityId: row.id, action: "create", after: row, userId });
    return row.id;
  });
}

export async function deleteExpense(id: string, userId?: string) {
  await db.transaction(async (tx) => {
    const before = await tx.query.expenses.findFirst({ where: eq(schema.expenses.id, id) });
    if (!before) throw new ExpenseError("notFound");
    try { await assertOpen(tx, before.date, before.paid ? before.paidAt : null); } catch { throw new ExpenseError("periodLocked"); }
    await tx.delete(schema.expenses).where(eq(schema.expenses.id, id));
    await audit(tx, { entity: "expense", entityId: id, action: "delete", before, userId });
  });
}
