import { beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { receiveGoods } from "../src/lib/stock";
import { issueInvoice, saveInvoiceDraft } from "../src/lib/sales";
import { recordPayment } from "../src/lib/payments";
import { deleteExpense, ExpenseError, saveExpense } from "../src/lib/expenses";
import { buildMonthPackage, collectMonth } from "../src/lib/advisor";
import { balances } from "../src/lib/datev";
import { monthReport } from "../src/lib/reports";
import { lockMonth, unlockMonth } from "../src/lib/periods";
import { todayIso } from "../src/lib/dates";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Ausgaben, Berichte, Monatsmappe (Datenbank)", () => {
  const month = todayIso().slice(0, 7);
  const day = todayIso();
  let invId = "", vendor = "";
  beforeAll(async () => {
    await db.insert(schema.companySettings).values({ id: "company", name: "Start Style" }).onConflictDoNothing();
    const [p] = await db.insert(schema.products).values({ sku: "ADV-" + crypto.randomUUID().slice(0, 6), nameDe: "Haarwachs", vatRateBp: 1900 }).returning();
    const v = (await db.insert(schema.variants).values({ productId: p.id }).returning())[0].id;
    await receiveGoods({ date: day, lines: [{ variantId: v, qty: 50, unitCostCents: 400 }] });
    const cust = (await db.insert(schema.customers).values({ name: "Barber Bochum", country: "DE" }).returning())[0].id;
    invId = await saveInvoiceDraft({ customerId: cust, channel: "STORE", discountBp: 0, notes: "", lines: [{ variantId: v, description: "Haarwachs", qty: 10, unitPriceCents: 1000, discountBp: 0, vatRateBp: 1900 }] });
    await issueInvoice(invId);
    await recordPayment({ invoiceId: invId, date: day, amountCents: 119_00, method: "CASH" });
    vendor = "Meta Platforms Ireland " + crypto.randomUUID().slice(0, 4);
  });

  it("Ausgabe mit neuem Lieferanten, Reverse-Charge, Duplikat-Schutz", async () => {
    const id = await saveExpense({
      date: day, vendorName: vendor, vendorCountry: "IE", vendorVatId: "IE9692928F", invoiceNo: "FB-1",
      category: "ADVERTISING", taxCase: "EU_SERVICE", channel: "BRAND_SHOP", amountCents: 50_00, vatRateBp: 1900,
      paid: true, paidAt: day, paymentMethod: "CARD", note: "",
    });
    const e = await db.query.expenses.findFirst({ where: eq(schema.expenses.id, id), with: { supplier: true } });
    expect(e).toMatchObject({ netCents: 50_00, vatCents: 0, grossCents: 50_00, taxCase: "EU_SERVICE" });
    expect(e!.supplier!.vatId).toBe("IE9692928F");
    await expect(saveExpense({ ...e!, id: undefined, vendorName: vendor, vendorVatId: "", amountCents: 1, paymentMethod: "CARD", paidAt: day, note: "", channel: null } as never))
      .rejects.toMatchObject({ code: "duplicate" });
    await saveExpense({
      date: day, vendorName: "Büro Müller " + crypto.randomUUID().slice(0, 4), vendorCountry: "DE", vendorVatId: "", invoiceNo: "",
      category: "STORE_SUPPLIES", taxCase: "DOMESTIC", channel: null, amountCents: 23_80, vatRateBp: 1900, paid: false, paidAt: null, paymentMethod: null, note: "",
    });
  });

  it("Bericht: Rohertrag aus Wareneinsatz, Kosten je Kanal, Vorsteuer", async () => {
    const r = await monthReport(month);
    const store = r.channels.find((c) => c.channel === "STORE")!;
    expect(store.revenueNet).toBeGreaterThanOrEqual(100_00);
    expect(store.cogs).toBeGreaterThanOrEqual(40_00);
    expect(r.channels.find((c) => c.channel === "BRAND_SHOP")!.direct).toBeGreaterThanOrEqual(50_00);
    expect(r.vat.inputVat).toBeGreaterThanOrEqual(3_80);
    expect(r.vat.selfAssessed).toBeGreaterThanOrEqual(9_50);
  });

  it("DATEV: Rechnung, Zahlung, Ausgabe; Debitor ausgeglichen; Mappe vollständig", async () => {
    const d = await collectMonth(month);
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invId), with: { customer: true } });
    const deb = 10000 + inv!.customer.number;
    const mine = d.bookings.filter((b) => b.account === deb || b.contra === deb);
    expect(mine).toHaveLength(2);
    expect(balances(mine).get(deb)).toBe(0);
    expect(mine.find((b) => b.contra === 8400)).toMatchObject({ amountCents: 119_00, side: "S", ref1: inv!.number });
    expect(mine.find((b) => b.account === 1000)).toMatchObject({ amountCents: 119_00, side: "S" });
    const fb = d.bookings.find((b) => b.ref1 === "FB-1")!;
    expect(fb).toMatchObject({ account: 4600, bu: "94", euVatId: "IE9692928F", amountCents: 50_00 });
    expect(d.bookings.find((b) => b.ref1 === "FB-1" && b.contra === 1360)).toBeTruthy();

    const pkg = await buildMonthPackage(month, "Test");
    const zip = await JSZip.loadAsync(pkg.data);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith(`EXTF_Buchungsstapel_${month}.csv`))).toBe(true);
    expect(names.some((n) => n.endsWith(`Ausgangsrechnungen/${inv!.number}.pdf`))).toBe(true);
    expect(names.some((n) => n.endsWith(`Monatsuebersicht_${month}.pdf`))).toBe(true);
    const csv = await zip.file(names.find((n) => n.includes("Buchungsstapel"))!)!.async("nodebuffer");
    expect(csv.subarray(0, 6).toString("latin1")).toBe('"EXTF"');
    expect(pkg.missingReceipts).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("Abgeschlossener Monat sperrt Ausgaben und Zahlungen", async () => {
    const past = "2020-03";
    await lockMonth(past);
    await expect(saveExpense({
      date: "2020-03-10", vendorName: vendor, vendorCountry: "IE", vendorVatId: "", invoiceNo: "", category: "OTHER", taxCase: "NO_VAT", channel: null,
      amountCents: 100, vatRateBp: 0, paid: false, paidAt: null, paymentMethod: null, note: "",
    })).rejects.toMatchObject({ code: "periodLocked" });
    await expect(recordPayment({ invoiceId: invId, date: "2020-03-10", amountCents: 1, method: "CASH" })).rejects.toMatchObject({ code: "periodLocked" });
    await unlockMonth(past);
    await expect(lockMonth(month)).rejects.toThrow("notPast");
    await expect(deleteExpense("nope")).rejects.toBeInstanceOf(ExpenseError);
  });
});
