import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { receiveGoods } from "../src/lib/stock";
import {
  availability, cancelInvoice, issueInvoice, offerToInvoice, saveInvoiceDraft, saveOffer, SalesError, startCorrection,
} from "../src/lib/sales";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Verkauf", () => {
  let v = "", deCustomer = "", nlPending = "";
  beforeAll(async () => {
    await db.insert(schema.companySettings).values({ id: "company", name: "Test GmbH", vatId: "DE123456789" }).onConflictDoNothing();
    const [p] = await db.insert(schema.products).values({ sku: "SALE-" + crypto.randomUUID().slice(0, 6), nameDe: "Schere", vatRateBp: 1900, wholesalePriceCents: 2000 }).returning();
    const [vv] = await db.insert(schema.variants).values({ productId: p.id }).returning();
    v = vv.id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId: v, qty: 50, unitCostCents: 1000 }] });
    deCustomer = (await db.insert(schema.customers).values({ name: "Salon Berlin", country: "DE" }).returning())[0].id;
    nlPending = (await db.insert(schema.customers).values({ name: "Kapper Utrecht BV", country: "NL", vatIdStatus: "PENDING" }).returning())[0].id;
  });

  const line = (qty: number) => ({ variantId: v, description: "Schere", qty, unitPriceCents: 2000, discountBp: 0, vatRateBp: 1900 });

  it("Angebot reserviert Ware", async () => {
    const offerId = await saveOffer({ customerId: deCustomer, date: "2026-10-18", validUntil: "2099-12-31", discountBp: 500, notes: "", lines: [line(10)] });
    const av = await availability(db, [v]);
    expect(av.get(v)).toBe(40);
    const invId = await offerToInvoice(offerId);
    const { number } = await issueInvoice(invId);
    expect(number).toMatch(/^RE-\d{4}-\d{4}$/);
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invId) });
    expect(inv!.netCents).toBe(19000);        // 10 × 20 € − 5 %
    expect(inv!.vatCents).toBe(3610);
    expect(inv!.custName).toBe("Salon Berlin");
    const vv = await db.query.variants.findFirst({ where: eq(schema.variants.id, v) });
    expect(vv!.stockQty).toBe(40);
    expect((await availability(db, [v])).get(v)).toBe(40); // Reservierung erledigt
  });

  it("Ausgestellte Rechnung: Korrektur storniert alte und stellt neue aus", async () => {
    const id = await saveInvoiceDraft({ customerId: deCustomer, channel: "STORE", discountBp: 0, notes: "", lines: [line(5)] });
    await issueInvoice(id);
    const draft = await startCorrection(id);
    await saveInvoiceDraft({ id: draft, customerId: deCustomer, replacesInvoiceId: id, channel: "STORE", discountBp: 0, notes: "", lines: [line(3)] });
    const before = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) }))!;
    expect(before.status).toBe("ISSUED"); // noch nichts passiert
    await issueInvoice(draft);
    const old = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) }))!;
    expect(old.status).toBe("CANCELLED");
    const storno = await db.query.invoices.findFirst({ where: eq(schema.invoices.cancelsInvoiceId, id) });
    expect(storno!.grossCents).toBe(-before.grossCents);
    expect(storno!.number).toMatch(/^ST-/);
    const vv = await db.query.variants.findFirst({ where: eq(schema.variants.id, v) });
    expect(vv!.stockQty).toBe(37); // 40 − 5 + 5 − 3
  });

  it("NL-Firma ohne Nummer: deutsche USt; nach gültiger Nummer Korrektur ohne USt", async () => {
    const id = await saveInvoiceDraft({ customerId: nlPending, channel: "STORE", discountBp: 0, notes: "", lines: [line(1)] });
    await issueInvoice(id);
    const first = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) }))!;
    expect(first.taxMode).toBe("EU_PENDING_VATID");
    expect(first.vatCents).toBe(380);
    await db.update(schema.customers).set({ vatId: "NL123456789B01", vatIdStatus: "VALID" }).where(eq(schema.customers.id, nlPending));
    const draft = await startCorrection(id);
    await issueInvoice(draft);
    const fixed = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, draft) }))!;
    expect(fixed.taxMode).toBe("EU_REVERSE_CHARGE");
    expect(fixed.vatCents).toBe(0);
    expect(fixed.custVatId).toBe("NL123456789B01");
    expect(first.grossCents - fixed.grossCents).toBe(380); // zu erstatten
  });

  it("Ausgestellte Rechnung lässt sich nicht als Entwurf überschreiben", async () => {
    const id = await saveInvoiceDraft({ customerId: deCustomer, channel: "STORE", discountBp: 0, notes: "", lines: [line(1)] });
    await issueInvoice(id);
    await expect(saveInvoiceDraft({ id, customerId: deCustomer, channel: "STORE", discountBp: 0, notes: "", lines: [line(9)] })).rejects.toBeInstanceOf(SalesError);
    await cancelInvoice(id);
    await expect(cancelInvoice(id)).rejects.toBeInstanceOf(SalesError); // nicht doppelt
  });

  it("Zu wenig Bestand → Rechnung wird nicht ausgestellt, nichts halb gebucht", async () => {
    const id = await saveInvoiceDraft({ customerId: deCustomer, channel: "STORE", discountBp: 0, notes: "", lines: [line(9999)] });
    await expect(issueInvoice(id)).rejects.toMatchObject({ code: "notEnough" });
    const inv = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) }))!;
    expect(inv.status).toBe("DRAFT");
    expect(inv.number).toBeNull();
    const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.refId, id)));
    expect(moves).toHaveLength(0);
  });
});
