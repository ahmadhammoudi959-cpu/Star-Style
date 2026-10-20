import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { paymentState, splitInstallments, trafficLight } from "../src/lib/payment-status";
import { addDaysIso } from "../src/lib/dates";
import { receiveGoods } from "../src/lib/stock";
import { issueInvoice, saveInvoiceDraft, startCorrection } from "../src/lib/sales";
import { dunningPdf, receiptPdf, invoicePdf } from "../src/lib/pdf";
import { cancelPayment, createDunning, PaymentError, recordPayment, setInstallments } from "../src/lib/payments";

describe("Zahlungsstand (rein)", () => {
  const base = { grossCents: 10_000_00, dueDate: "2026-11-01", issueDate: "2026-10-18" };
  it("offen ohne Zahlung", () => {
    const s = paymentState({ ...base, installments: [], payments: [] }, "2026-10-20");
    expect(s).toMatchObject({ status: "OPEN", openCents: 10_000_00, overdueCents: 0, nextDueDate: "2026-11-01" });
  });
  it("Anzahlung 5.000, Rest später → teilweise bezahlt", () => {
    const s = paymentState({ ...base, installments: [{ dueDate: "2026-10-18", amountCents: 5_000_00 }, { dueDate: "2026-11-18", amountCents: 5_000_00 }], payments: [{ amountCents: 5_000_00 }] }, "2026-10-20");
    expect(s).toMatchObject({ status: "PARTIAL", openCents: 5_000_00, nextDueDate: "2026-11-18", overdueCents: 0 });
  });
  it("Rate verpasst → überfällig mit Tagen", () => {
    const s = paymentState({ ...base, installments: [{ dueDate: "2026-10-18", amountCents: 5_000_00 }, { dueDate: "2026-11-18", amountCents: 5_000_00 }], payments: [{ amountCents: 2_000_00 }] }, "2026-10-28");
    expect(s).toMatchObject({ status: "OVERDUE", overdueCents: 3_000_00, daysOverdue: 10 });
    expect(trafficLight(s, "2026-10-28")).toBe("red");
  });
  it("stornierte Zahlung zählt nicht", () => {
    const s = paymentState({ ...base, installments: [], payments: [{ amountCents: 10_000_00, cancelledAt: new Date() }] }, "2026-10-20");
    expect(s.status).toBe("OPEN");
  });
  it("Überzahlung = Guthaben", () => {
    expect(paymentState({ ...base, grossCents: 8990, installments: [], payments: [{ amountCents: 10698 }] }, "2026-10-20").status).toBe("CREDIT");
  });
  it("gelb, wenn in ≤ 7 Tagen fällig", () => {
    const s = paymentState({ ...base, installments: [], payments: [] }, "2026-10-27");
    expect(trafficLight(s, "2026-10-27")).toBe("yellow");
  });
  it("Ratenplan gleichmäßig, Rest auf letzte Rate", () => {
    const rows = splitInstallments(1000_01, 0, 3, "2026-11-01", 30, addDaysIso);
    expect(rows.map((r) => r.amountCents)).toEqual([333_33, 333_33, 333_35]);
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-11-01", "2026-12-01", "2026-12-31"]);
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Zahlungen (Datenbank)", () => {
  let v = "", cust = "";
  beforeAll(async () => {
    const [p] = await db.insert(schema.products).values({ sku: "PAY-" + crypto.randomUUID().slice(0, 6), nameDe: "Föhn", vatRateBp: 1900 }).returning();
    v = (await db.insert(schema.variants).values({ productId: p.id }).returning())[0].id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId: v, qty: 500, unitCostCents: 3000 }] });
    cust = (await db.insert(schema.customers).values({ name: "Salon Raten", country: "DE" }).returning())[0].id;
  });
  const line = (qty: number) => ({ variantId: v, description: "Föhn", qty, unitPriceCents: 10000, discountBp: 0, vatRateBp: 1900 });

  it("Anzahlung bei Ausstellung + Ratenplan, Rest in Raten bezahlt", async () => {
    // 100 × 100 € netto = 11.900 € brutto; 5.000 sofort bar, Rest in 2 Raten
    const id = await saveInvoiceDraft({
      customerId: cust, channel: "STORE", discountBp: 0, notes: "", lines: [line(100)],
      initialPaymentCents: 5_000_00, initialPaymentMethod: "CASH",
      installments: [{ dueDate: "2026-10-18", amountCents: 5_000_00 }, { dueDate: "2026-11-18", amountCents: 3_450_00 }, { dueDate: "2026-12-18", amountCents: 3_450_00 }],
    });
    await issueInvoice(id);
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { payments: true, installments: true } });
    expect(inv!.grossCents).toBe(11_900_00);
    expect(inv!.payments).toHaveLength(1);
    expect(inv!.payments[0]).toMatchObject({ amountCents: 5_000_00, method: "CASH" });
    expect(inv!.dueDate).toBe("2026-12-18");
    await recordPayment({ invoiceId: id, date: "2026-11-18", amountCents: 3_450_00, method: "BANK" });
    await expect(recordPayment({ invoiceId: id, date: "2026-11-19", amountCents: 9_999_00, method: "BANK" })).rejects.toMatchObject({ code: "overpay" });
    const p2 = await recordPayment({ invoiceId: id, date: "2026-12-18", amountCents: 3_450_00, method: "BANK" });
    let s = paymentState((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { payments: true, installments: true } }))!, "2026-12-20");
    expect(s.status).toBe("PAID");
    expect((await receiptPdf(p2.id)).length).toBeGreaterThan(1000);
    expect((await invoicePdf(id)).length).toBeGreaterThan(1000);
    await cancelPayment(p2.id, "Rücklastschrift");
    s = paymentState((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { payments: true, installments: true } }))!, "2026-12-20");
    expect(s).toMatchObject({ status: "OVERDUE", openCents: 3_450_00 });
  });

  it("Ratenplan muss genau aufgehen", async () => {
    const id = await saveInvoiceDraft({ customerId: cust, channel: "STORE", discountBp: 0, notes: "", lines: [line(1)] });
    await issueInvoice(id);
    await expect(setInstallments(id, [{ dueDate: "2026-11-01", amountCents: 100 }])).rejects.toBeInstanceOf(PaymentError);
    await setInstallments(id, [{ dueDate: "2026-11-01", amountCents: 50_00 }, { dueDate: "2026-12-01", amountCents: 69_00 }]);
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
    expect(inv!.dueDate).toBe("2026-12-01");
  });

  it("Korrektur übernimmt Zahlungen und passt Plan an", async () => {
    const id = await saveInvoiceDraft({
      customerId: cust, channel: "STORE", discountBp: 0, notes: "", lines: [line(10)],
      installments: [{ dueDate: "2026-10-18", amountCents: 500_00 }, { dueDate: "2026-11-18", amountCents: 690_00 }],
    });
    await issueInvoice(id);
    await recordPayment({ invoiceId: id, date: "2026-10-18", amountCents: 500_00, method: "CASH" });
    const draft = await startCorrection(id);
    await saveInvoiceDraft({ id: draft, customerId: cust, replacesInvoiceId: id, channel: "STORE", discountBp: 0, notes: "", lines: [line(8)] });
    await issueInvoice(draft);
    const fresh = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, draft), with: { payments: true, installments: true } });
    expect(fresh!.grossCents).toBe(952_00);
    expect(fresh!.payments.map((p) => p.amountCents)).toEqual([500_00]);
    expect(fresh!.installments.reduce((s, r) => s + r.amountCents, 0)).toBe(952_00);
  });

  it("Mahnstufen steigen nur bei Überfälligkeit", async () => {
    const id = await saveInvoiceDraft({ customerId: cust, channel: "STORE", discountBp: 0, notes: "", lines: [line(1)] });
    await issueInvoice(id);
    await expect(createDunning(id)).rejects.toMatchObject({ code: "notOverdue" });
    await setInstallments(id, [{ dueDate: "2020-01-01", amountCents: 119_00 }]);
    const d1 = await createDunning(id);
    const d2 = await createDunning(id);
    expect([d1.level, d2.level]).toEqual([1, 2]);
    const pdf = await dunningPdf(d2.id);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
  });
});

describe("Skonto (rein)", () => {
  it("Aufteilung auf Steuersätze geht exakt auf", async () => {
    const { skontoSplit, skontoMax } = await import("../src/lib/tax");
    expect(skontoMax(1_963_50, 500)).toBe(98_18);
    const parts = skontoSplit(98_18, [{ rateBp: 1900, netCents: 1_000_00, vatCents: 190_00 }, { rateBp: 700, netCents: 650_00, vatCents: 45_50 }]);
    expect(parts.reduce((s, g) => s + g.netCents + g.vatCents, 0)).toBe(98_18);
    const g19 = parts.find((g) => g.rateBp === 1900)!;
    expect(g19.vatCents).toBe(Math.round(((g19.netCents + g19.vatCents) * 1900) / 11900));
    expect(g19.netCents + g19.vatCents).toBeGreaterThan(parts.find((g) => g.rateBp === 700)!.netCents);
  });
  it("Skonto zählt im Zahlungsstand wie bezahlt", () => {
    const s = paymentState({ grossCents: 1_963_50, dueDate: "2026-11-01", issueDate: "2026-10-20", installments: [], payments: [{ amountCents: 1_865_32, skontoCents: 98_18 }] }, "2026-10-21");
    expect(s).toMatchObject({ status: "PAID", openCents: 0 });
  });
});

run("Skonto (Datenbank)", () => {
  it("Zahlung innerhalb der Frist mit Skonto erledigt die Rechnung, DATEV bucht 8736", async () => {
    const [p] = await db.insert(schema.products).values({ sku: "SK-" + crypto.randomUUID().slice(0, 6), nameDe: "Schere", vatRateBp: 1900 }).returning();
    const v = (await db.insert(schema.variants).values({ productId: p.id }).returning())[0].id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId: v, qty: 50, unitCostCents: 3000 }] });
    const cust = (await db.insert(schema.customers).values({ name: "Salon Skonto", country: "DE" }).returning())[0].id;
    const id = await saveInvoiceDraft({ customerId: cust, channel: "STORE", discountBp: 0, skontoBp: 500, skontoDays: 7, notes: "",
      lines: [{ variantId: v, description: "Schere", qty: 15, unitPriceCents: 110_00, discountBp: 0, vatRateBp: 1900 }] });
    await issueInvoice(id);
    const inv = (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) }))!;
    expect(inv.grossCents).toBe(1_963_50);
    const day = inv.issueDate!;
    // zu wenig bezahlt → Fehler mit Mindestbetrag
    await expect(recordPayment({ invoiceId: id, date: day, amountCents: 1_500_00, method: "BANK", withSkonto: true })).rejects.toMatchObject({ code: "skontoAmount", detail: "186532" });
    // nach Fristende → Fehler
    await expect(recordPayment({ invoiceId: id, date: addDaysIso(day, 8), amountCents: 1_865_32, method: "BANK", withSkonto: true })).rejects.toMatchObject({ code: "skontoExpired" });
    const pay = await recordPayment({ invoiceId: id, date: day, amountCents: 1_865_32, method: "BANK", withSkonto: true });
    expect(pay).toMatchObject({ skontoCents: 98_18, skontoNetCents: 82_50 });
    const s = paymentState((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { payments: true, installments: true } }))!, day);
    expect(s.status).toBe("PAID");
    expect((await receiptPdf(pay.id)).length).toBeGreaterThan(1000);
    const { collectMonth } = await import("../src/lib/advisor");
    const m = await collectMonth(day.slice(0, 7));
    const sk = m.bookings.filter((b) => b.ref2 === pay.number && b.text.startsWith("Skonto"));
    expect(sk).toHaveLength(1);
    expect(sk[0]).toMatchObject({ amountCents: 98_18, side: "S", account: m.accounts.skonto19 });
    const { monthReport } = await import("../src/lib/reports");
    const r = await monthReport(day.slice(0, 7));
    expect(r.totals.skonto).toBeGreaterThanOrEqual(82_50);
  });
});
