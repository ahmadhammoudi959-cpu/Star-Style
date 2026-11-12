import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { saveExpense, supplierKindForExpense, type ExpenseInput } from "../src/lib/expenses";
import { todayIso } from "../src/lib/dates";

// Firmen aus Ausgaben (Baumarkt, Steuerbüro …) stehen nicht bei den Lieferanten/im Wareneingang (Wunsch Inhaber 12.11.2026)
describe("Art des Lieferanten (rein)", () => {
  it("Wareneinkauf = Warenlieferant, alles andere = Firma aus Ausgaben", () => {
    expect(supplierKindForExpense("GOODS")).toBe("GOODS");
    for (const c of ["STORE_SUPPLIES", "CONSULTING", "ADVERTISING", "SHIPPING", "OTHER"] as const) expect(supplierKindForExpense(c)).toBe("EXPENSE");
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Art des Lieferanten (Datenbank)", () => {
  const day = todayIso();
  const base = (vendorName: string, category: ExpenseInput["category"], invoiceNo: string): ExpenseInput => ({
    date: day, vendorName, vendorCountry: "DE", vendorVatId: "", invoiceNo, category, taxCase: "DOMESTIC", channel: null,
    amountCents: 169_00, vatRateBp: 1900, paid: true, paidAt: day, paymentMethod: "CARD", note: "",
  });
  const kindOf = async (name: string) => (await db.query.suppliers.findFirst({ where: eq(schema.suppliers.name, name) }))?.kind;

  it("neue Firma aus einer Ausgabe = Firma aus Ausgaben, bei Wareneinkauf = Warenlieferant", async () => {
    const tag = crypto.randomUUID().slice(0, 6);
    await saveExpense(base(`Hornbach ${tag}`, "STORE_SUPPLIES", "009253"));
    await saveExpense(base(`Steuerbüro ${tag}`, "CONSULTING", "263388"));
    await saveExpense(base(`Großhändler ${tag}`, "GOODS", "W-1"));
    expect(await kindOf(`Hornbach ${tag}`)).toBe("EXPENSE");
    expect(await kindOf(`Steuerbüro ${tag}`)).toBe("EXPENSE");
    expect(await kindOf(`Großhändler ${tag}`)).toBe("GOODS");
  });

  it("Firma aus Ausgaben, die dann Ware liefert, wird Warenlieferant (mit Protokoll) – nie umgekehrt", async () => {
    const tag = crypto.randomUUID().slice(0, 6);
    const name = `Q-Design ${tag}`;
    await saveExpense(base(name, "SHIPPING", "S-1"));
    expect(await kindOf(name)).toBe("EXPENSE");
    await saveExpense(base(name, "GOODS", "INV-2"));
    expect(await kindOf(name)).toBe("GOODS");
    const s = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.name, name) });
    const log = await db.query.auditLog.findMany({ where: and(eq(schema.auditLog.entity, "supplier"), eq(schema.auditLog.entityId, s!.id), eq(schema.auditLog.action, "update")) });
    expect(log.some((l) => (l.after as { kind?: string })?.kind === "GOODS")).toBe(true);
    // weitere Ausgaben (z. B. Versand) machen aus dem Warenlieferanten keine Firma aus Ausgaben
    await saveExpense(base(name, "SHIPPING", "S-3"));
    expect(await kindOf(name)).toBe("GOODS");
  });

  it("vorhandener Warenlieferant bleibt Warenlieferant, gleiche Firma wird nicht doppelt angelegt", async () => {
    const tag = crypto.randomUUID().slice(0, 6);
    const [g] = await db.insert(schema.suppliers).values({ name: `DeltaPro ${tag}` }).returning();
    await saveExpense(base(`deltapro ${tag}`, "OTHER", `D-${tag}`)); // Groß-/Kleinschreibung egal
    const all = await db.query.suppliers.findMany({ where: eq(schema.suppliers.id, g.id) });
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("GOODS");
    const e = await db.query.expenses.findFirst({ where: eq(schema.expenses.invoiceNo, `D-${tag}`) });
    expect(e?.supplierId).toBe(g.id);
  });
});
