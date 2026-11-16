import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { receiveGoods } from "../src/lib/stock";
import { issueInvoice, saveInvoiceDraft, startCorrection } from "../src/lib/sales";
import { recordPayment, cancelPayment, creditOf, PaymentError, recordRefund } from "../src/lib/payments";
import { paymentState } from "../src/lib/payment-status";
import { allocateDamaged, planReturn, type PlanInvoice } from "../src/lib/returns-plan";
import { bookReturn, ReturnError, returnBlock } from "../src/lib/returns";
import { collectMonth } from "../src/lib/advisor";
import { balances } from "../src/lib/datev";
import { customerStatement } from "../src/lib/receivables";
import { todayIso } from "../src/lib/dates";

// Retouren (Wunsch Inhaber 16.11.2026: „تسجيل المرتجعات“)
describe("Retoure planen (rein)", () => {
  const inv: PlanInvoice = {
    grossCents: 238_00, discountBp: 0, pricesGross: false, paidCents: 238_00,
    lines: [
      { id: "a", position: 1, variantId: "v1", description: "Schere", qty: 10, unitPriceCents: 20_00, discountBp: 0, vatRateBp: 1900 },
      { id: "b", position: 2, variantId: null, description: "Versand", qty: 1, unitPriceCents: 0, discountBp: 0, vatRateBp: 1900 },
    ],
  };

  it("nichts eingetragen, zu viel, beschädigte Versandkosten, unbekannte Position", () => {
    expect(planReturn(inv, [])).toEqual({ ok: false, error: "nothing" });
    expect(planReturn(inv, [{ lineId: "a", restock: 0, damaged: 0 }])).toEqual({ ok: false, error: "nothing" });
    expect(planReturn(inv, [{ lineId: "a", restock: 8, damaged: 3 }])).toMatchObject({ ok: false, error: "qty" });
    expect(planReturn(inv, [{ lineId: "a", restock: 6, damaged: 0 }, { lineId: "a", restock: 5, damaged: 0 }])).toMatchObject({ ok: false, error: "qty" });
    expect(planReturn(inv, [{ lineId: "b", restock: 0, damaged: 1 }])).toMatchObject({ ok: false, error: "damagedNoGoods" });
    expect(planReturn(inv, [{ lineId: "x", restock: 1, damaged: 0 }])).toMatchObject({ ok: false, error: "unknownLine" });
    expect(planReturn(inv, [{ lineId: "a", restock: -1, damaged: 0 }])).toMatchObject({ ok: false, error: "qty" });
    expect(planReturn(inv, [{ lineId: "a", restock: 1.5, damaged: 0 }])).toMatchObject({ ok: false, error: "qty" });
  });

  it("Teilretoure: neue Rechnung mit Restmengen, Gutschrift und Guthaben", () => {
    const p = planReturn(inv, [{ lineId: "a", restock: 2, damaged: 1 }]);
    if (!p.ok) throw new Error(p.error);
    expect(p.full).toBe(false);
    expect(p.keep.map((l) => [l.id, l.qty])).toEqual([["a", 7], ["b", 1]]);
    expect(p.lines.map((x) => [x.line.id, x.qty, x.condition])).toEqual([["a", 2, "RESTOCK"], ["a", 1, "DAMAGED"]]);
    expect(p.newGrossCents).toBe(166_60); // 7 × 20 € + 19 %
    expect(p.creditCents).toBe(71_40);
    expect(p.refundableCents).toBe(71_40);
    expect(p.units).toBe(3);
  });

  it("alles zurück = nur Storno; ohne Zahlung nichts auszuzahlen", () => {
    const p = planReturn({ ...inv, paidCents: 0 }, [{ lineId: "a", restock: 10, damaged: 0 }, { lineId: "b", restock: 1, damaged: 0 }]);
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ full: true, newGrossCents: 0, creditCents: 238_00, refundableCents: 0, keep: [] });
  });

  it("Teilzahlung: Guthaben erst, wenn mehr bezahlt als die neue Rechnung", () => {
    const p = planReturn({ ...inv, paidCents: 100_00 }, [{ lineId: "a", restock: 3, damaged: 0 }]);
    expect(p).toMatchObject({ ok: true, newGrossCents: 166_60, refundableCents: 0 });
  });

  it("Rabatt auf die ganze Rechnung gilt auch für die Restmengen", () => {
    const p = planReturn({ ...inv, discountBp: 1000, grossCents: 214_20 }, [{ lineId: "a", restock: 5, damaged: 0 }]);
    expect(p).toMatchObject({ ok: true, newGrossCents: 107_10, creditCents: 107_10 }); // 5 × 20 € − 10 % + 19 %
  });

  it("beschädigte Ware aus den zurückgekommenen Chargen", () => {
    expect(allocateDamaged(3, [{ id: "c1", qtyLeft: 2 }, { id: "c2", qtyLeft: 5 }])).toEqual([{ batchId: "c1", qty: 2 }, { batchId: "c2", qty: 1 }]);
    expect(allocateDamaged(4, [{ id: "c1", qtyLeft: 1 }])).toEqual([{ batchId: "c1", qty: 1 }, { batchId: null, qty: 3 }]);
    expect(allocateDamaged(2, [{ id: "c0", qtyLeft: 0 }, { id: "c1", qtyLeft: 2 }])).toEqual([{ batchId: "c1", qty: 2 }]);
  });

  it("Shop-Bestellungen und nicht ausgestellte Rechnungen gehen nicht", () => {
    expect(returnBlock({ kind: "INVOICE", status: "ISSUED", externalOrderId: null })).toBeNull();
    expect(returnBlock({ kind: "INVOICE", status: "ISSUED", externalOrderId: "gid://shopify/Order/1" })).toBe("shopOrder");
    expect(returnBlock({ kind: "INVOICE", status: "CANCELLED", externalOrderId: null })).toBe("notIssued");
    expect(returnBlock({ kind: "CANCELLATION", status: "ISSUED", externalOrderId: null })).toBe("notIssued");
    expect(returnBlock({ kind: "INVOICE", status: "DRAFT", externalOrderId: null })).toBe("notIssued");
  });

  it("Guthaben einer Rechnung (auch ganz storniert)", () => {
    expect(creditOf({ status: "ISSUED", grossCents: 100, payments: [{ amountCents: 150 }, { amountCents: 20, cancelledAt: new Date() }] })).toBe(50);
    expect(creditOf({ status: "CANCELLED", grossCents: 100, payments: [{ amountCents: 80 }] })).toBe(80);
    expect(creditOf({ status: "ISSUED", grossCents: 100, payments: [{ amountCents: 60 }] })).toBe(0);
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Retouren (Datenbank)", () => {
  const day = todayIso();
  let v = "", cust = "", batchExpiry = "";
  const stock = async () => (await db.query.variants.findFirst({ where: eq(schema.variants.id, v) }))!.stockQty;
  const line = (qty: number) => ({ variantId: v, description: "Färbeschale", qty, unitPriceCents: 20_00, discountBp: 0, vatRateBp: 1900 });
  const sell = async (qty: number, extra: { shipping?: boolean } = {}) => {
    const id = await saveInvoiceDraft({
      customerId: cust, channel: "STORE", discountBp: 0, notes: "",
      lines: [line(qty), ...(extra.shipping ? [{ variantId: null, description: "Versand", qty: 1, unitPriceCents: 5_00, discountBp: 0, vatRateBp: 1900 }] : [])],
    });
    await issueInvoice(id);
    return (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { lines: true } }))!;
  };

  beforeAll(async () => {
    await db.insert(schema.companySettings).values({ id: "company", name: "Test GmbH" }).onConflictDoNothing();
    const [p] = await db.insert(schema.products).values({ sku: "RET-" + crypto.randomUUID().slice(0, 6), nameDe: "Färbeschale", vatRateBp: 1900, tracksExpiry: true }).returning();
    v = (await db.insert(schema.variants).values({ productId: p.id, barcode: "RT" + crypto.randomUUID().slice(0, 8) }).returning())[0].id;
    batchExpiry = "2099-03-31";
    await receiveGoods({ date: day, lines: [{ variantId: v, qty: 50, unitCostCents: 8_00, batchNo: "L-77", expiryDate: batchExpiry }] });
    cust = (await db.insert(schema.customers).values({ name: "Salon Retoure " + crypto.randomUUID().slice(0, 4), country: "DE" }).returning())[0].id;
  });

  it("Teilretoure: Storno + neue Rechnung, Lager mit MHD zurück, beschädigt → Verlust, bar erstattet", async () => {
    const inv = await sell(10);
    await recordPayment({ invoiceId: inv.id, date: day, amountCents: 238_00, method: "CASH" });
    expect(await stock()).toBe(40);

    const r = await bookReturn({
      invoiceId: inv.id, reason: "damaged", note: "Karton nass",
      picks: [{ lineId: inv.lines[0].id, restock: 2, damaged: 1 }], refund: { method: "CASH", amountCents: 71_40 },
    });
    expect(r.number).toMatch(/^RT-\d{4}-\d{4}$/);

    const old = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id) }))!;
    expect(old.status).toBe("CANCELLED");
    const st = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, r.cancellationId) }))!;
    expect(st).toMatchObject({ kind: "CANCELLATION", grossCents: -238_00, cancelsInvoiceId: inv.id });
    const neu = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, r.correctionId!), with: { lines: true, payments: true, installments: true } }))!;
    expect(neu).toMatchObject({ status: "ISSUED", kind: "INVOICE", grossCents: 166_60, replacesInvoiceId: inv.id, dueDate: old.dueDate, taxLocked: true });
    expect(neu.number).toMatch(/^RE-/);
    expect(neu.lines.map((l) => l.qty)).toEqual([7]);
    expect(neu.notes).toContain(r.number);

    // Lager: 40 + 10 (Storno) − 7 (neue Rechnung) − 1 (Verlust) = 42
    expect(await stock()).toBe(42);
    const back = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.refId, r.cancellationId), eq(schema.stockMovements.type, "CANCEL")));
    expect(back.reduce((s, m) => s + m.qty, 0)).toBe(10);
    expect(back[0].note).toContain(r.number);
    const cancelBatch = await db.query.batches.findFirst({ where: eq(schema.batches.id, back[0].batchId!) });
    expect(cancelBatch).toMatchObject({ expiryDate: batchExpiry, batchNo: "L-77", unitCostCents: 8_00 }); // MHD + Charge wie verkauft

    // Verlust aus der zurückgekommenen Charge, zum EK
    const ret = (await db.query.returns.findFirst({ where: eq(schema.returns.id, r.id), with: { lines: true } }))!;
    expect(ret).toMatchObject({ creditCents: 71_40, refundCents: 71_40, refundMethod: "CASH", reason: "damaged", note: "Karton nass", customerId: cust });
    expect(ret.lines.map((l) => [l.qty, l.condition]).sort()).toEqual([[1, "DAMAGED"], [2, "RESTOCK"]]);
    const wo = (await db.query.writeOffs.findFirst({ where: eq(schema.writeOffs.id, ret.writeOffId!), with: { lines: true } }))!;
    expect(wo).toMatchObject({ reason: "DAMAGE" });
    expect(wo.note).toContain(r.number);
    expect(wo.lines).toHaveLength(1);
    expect(wo.lines[0]).toMatchObject({ qty: 1, unitCostCents: 8_00 });
    expect(back.map((m) => m.batchId)).toContain(wo.lines[0].batchId);

    // Zahlung gewandert, Erstattung als negative Zahlung → bezahlt
    const pays = neu.payments;
    expect(pays.map((p) => p.amountCents).sort((a, b) => a - b)).toEqual([-71_40, 238_00]);
    expect(pays.find((p) => p.amountCents < 0)!.number).toMatch(/^QU-/);
    expect(paymentState(neu, day).status).toBe("PAID");

    // Kundenkonto: Saldo 0, Erstattung als eigene Zeile
    const statement = await customerStatement(cust);
    const mine = statement.filter((x) => [inv.number, neu.number, st.number].includes(x.text) || x.refId === neu.id || x.refId === inv.id || x.refId === st.id);
    expect(mine.some((x) => x.kind === "refund" && x.amountCents === 71_40)).toBe(true);

    // DATEV: Debitor ausgeglichen, Kasse = 238 − 71,40
    const d = await collectMonth(day.slice(0, 7));
    const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, cust) });
    const deb = 10000 + c!.number;
    const bk = d.bookings.filter((b) => b.account === deb || b.contra === deb);
    expect(balances(bk).get(deb)).toBe(0);
    const refundBooking = bk.find((b) => b.text?.startsWith("Erstattung"))!;
    expect(refundBooking).toMatchObject({ amountCents: 71_40, side: "H", account: 1000 });

    // Protokoll
    const log = await db.query.auditLog.findFirst({ where: and(eq(schema.auditLog.entity, "return"), eq(schema.auditLog.entityId, r.id)) });
    expect(log?.action).toBe("create");
  }, 60_000); // Monatsmappe liest den ganzen Monat der Test-Datenbank

  it("alles zurück ohne Zahlung: nur Storno, Bestand wieder wie vorher", async () => {
    const before = await stock();
    const inv = await sell(4, { shipping: true });
    const r = await bookReturn({
      invoiceId: inv.id, reason: "unwanted", note: "",
      picks: inv.lines.map((l) => ({ lineId: l.id, restock: l.qty, damaged: 0 })), refund: null,
    });
    expect(r.correctionId).toBeNull();
    expect((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id) }))!.status).toBe("CANCELLED");
    expect(await stock()).toBe(before);
    const ret = (await db.query.returns.findFirst({ where: eq(schema.returns.id, r.id), with: { lines: true } }))!;
    expect(ret).toMatchObject({ creditCents: inv.grossCents, refundCents: 0, writeOffId: null, refundPaymentId: null });
    expect(ret.lines).toHaveLength(2); // Ware + Versand (Gutschrift)
  });

  it("alles zurück, bezahlt: Erstattung auf der stornierten Rechnung; erst Guthaben lassen, später auszahlen", async () => {
    const inv = await sell(1);
    await recordPayment({ invoiceId: inv.id, date: day, amountCents: 23_80, method: "BANK" });
    await bookReturn({ invoiceId: inv.id, reason: "wrong", note: "", picks: [{ lineId: inv.lines[0].id, restock: 1, damaged: 0 }], refund: null });
    let cur = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id), with: { payments: true } }))!;
    expect(creditOf(cur)).toBe(23_80);
    await expect(recordRefund({ invoiceId: inv.id, date: day, amountCents: 30_00, method: "BANK" })).rejects.toMatchObject({ code: "refundTooHigh", detail: "2380" });
    await recordRefund({ invoiceId: inv.id, date: day, amountCents: 23_80, method: "BANK" });
    cur = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id), with: { payments: true } }))!;
    expect(creditOf(cur)).toBe(0);
    // Erstattung storniert → Guthaben wieder da
    const refund = cur.payments.find((p) => p.amountCents < 0)!;
    await cancelPayment(refund.id, "falsch gebucht");
    cur = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id), with: { payments: true } }))!;
    expect(creditOf(cur)).toBe(23_80);
  });

  it("zu hohe Erstattung bucht nichts (auch keine Nummer)", async () => {
    const inv = await sell(2);
    await recordPayment({ invoiceId: inv.id, date: day, amountCents: 47_60, method: "CASH" });
    const seq = async () => (await db.query.numberSequences.findFirst({ where: and(eq(schema.numberSequences.kind, "RETURN"), eq(schema.numberSequences.year, Number(day.slice(0, 4)))) }))?.next ?? 0;
    const n = await seq();
    const s = await stock();
    await expect(bookReturn({
      invoiceId: inv.id, reason: "other", note: "", picks: [{ lineId: inv.lines[0].id, restock: 1, damaged: 0 }], refund: { method: "CASH", amountCents: 30_00 },
    })).rejects.toMatchObject({ code: "refundTooHigh", detail: "2380" });
    expect((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id) }))!.status).toBe("ISSUED");
    expect(await seq()).toBe(n);
    expect(await stock()).toBe(s);
  });

  it("Shop-Bestellung, offener Korrekturentwurf und stornierte Rechnung werden abgelehnt", async () => {
    const shop = await sell(1);
    await db.update(schema.invoices).set({ externalOrderId: "gid://shopify/Order/99" }).where(eq(schema.invoices.id, shop.id));
    await expect(bookReturn({ invoiceId: shop.id, reason: "other", note: "", picks: [{ lineId: shop.lines[0].id, restock: 1, damaged: 0 }], refund: null }))
      .rejects.toMatchObject({ code: "shopOrder" });

    const inv = await sell(3);
    const draft = await startCorrection(inv.id);
    await expect(bookReturn({ invoiceId: inv.id, reason: "other", note: "", picks: [{ lineId: inv.lines[0].id, restock: 1, damaged: 0 }], refund: null }))
      .rejects.toMatchObject({ code: "correctionOpen", detail: draft });

    const done = await sell(1);
    await bookReturn({ invoiceId: done.id, reason: "other", note: "", picks: [{ lineId: done.lines[0].id, restock: 1, damaged: 0 }], refund: null });
    const again = bookReturn({ invoiceId: done.id, reason: "other", note: "", picks: [{ lineId: done.lines[0].id, restock: 1, damaged: 0 }], refund: null });
    await expect(again).rejects.toBeInstanceOf(ReturnError);
    await expect(again).rejects.toMatchObject({ code: "notIssued" });
  });

  it("Retoure auf die neue Rechnung einer früheren Retoure (Kette)", async () => {
    const inv = await sell(6);
    const r1 = await bookReturn({ invoiceId: inv.id, reason: "other", note: "", picks: [{ lineId: inv.lines[0].id, restock: 2, damaged: 0 }], refund: null });
    const second = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, r1.correctionId!), with: { lines: true } }))!;
    expect(second.lines[0].qty).toBe(4);
    const r2 = await bookReturn({ invoiceId: second.id, reason: "other", note: "", picks: [{ lineId: second.lines[0].id, restock: 1, damaged: 0 }], refund: null });
    const third = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, r2.correctionId!), with: { lines: true } }))!;
    expect(third.lines[0].qty).toBe(3);
    expect(third.replacesInvoiceId).toBe(second.id);
  });

  it("Erstattung nur mit Guthaben; normale Zahlung bleibt positiv", async () => {
    const inv = await sell(1);
    await expect(recordRefund({ invoiceId: inv.id, date: day, amountCents: 1_00, method: "CASH" })).rejects.toBeInstanceOf(PaymentError);
    await expect(recordRefund({ invoiceId: inv.id, date: day, amountCents: 0, method: "CASH" })).rejects.toMatchObject({ code: "amountInvalid" });
  });
});
