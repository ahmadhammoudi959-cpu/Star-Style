import { describe, expect, it, vi, afterEach } from "vitest";
import { expiryRisks, reorderSuggestions, slowMovers, type StockItem } from "../src/lib/insights";
import { mapReceipt } from "../src/lib/ai/receipt-map";
import { narrative } from "../src/lib/narrative";

const base: StockItem = { variantId: "v", name: "Föhn", sku: "F1", supplierId: "s", supplierName: "Barber Supply", stock: 10, reserved: 0, minStock: 0, sold: 0, unitCostCents: 1000, lastReceipt: "2026-01-01" };

describe("Nachbestellen", () => {
  it("90 verkauft (1/Tag), 10 da → dringend, Menge deckt 74 Tage", () => {
    const [r] = reorderSuggestions([{ ...base, sold: 90 }]);
    expect(r).toMatchObject({ daysLeft: 10, urgency: "urgent", qty: 64, costCents: 64000 });
  });
  it("Reservierungen zählen nicht als verfügbar; ausverkauft", () => {
    const [r] = reorderSuggestions([{ ...base, sold: 45, reserved: 10 }]);
    expect(r).toMatchObject({ available: 0, urgency: "out" });
  });
  it("Mindestbestand ohne Verkäufe", () => {
    const [r] = reorderSuggestions([{ ...base, stock: 2, minStock: 5 }]);
    expect(r.qty).toBe(4);
  });
  it("genug Bestand → kein Vorschlag", () => {
    expect(reorderSuggestions([{ ...base, stock: 100, sold: 90 }])).toHaveLength(0);
  });
});

describe("Ablauf-Risiko (FEFO)", () => {
  const per = new Map([["v", 1]]); // 1 Stück pro Tag
  it("frühe Charge verbraucht das Tempo zuerst", () => {
    const r = expiryRisks([
      { batchId: "b1", variantId: "v", name: "Gel", expiry: "2026-11-17", qtyLeft: 20, unitCostCents: 300 }, // 30 Tage
      { batchId: "b2", variantId: "v", name: "Gel", expiry: "2026-12-17", qtyLeft: 50, unitCostCents: 300 }, // 60 Tage
    ], per, "2026-10-18");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ batchId: "b2", expectedSold: 40, riskQty: 10, riskCents: 3000, action: "watch" });
  });
  it("abgelaufen → als Verlust buchen", () => {
    const r = expiryRisks([{ batchId: "b", variantId: "x", name: "Gel", expiry: "2026-10-01", qtyLeft: 3, unitCostCents: 100 }], new Map(), "2026-10-18");
    expect(r[0]).toMatchObject({ action: "writeOff", riskQty: 3 });
  });
});

it("Ladenhüter: Bestand ohne Verkauf, älter als 60 Tage", () => {
  const r = slowMovers([base, { ...base, variantId: "n", lastReceipt: "2026-10-01" }, { ...base, variantId: "s2", sold: 3 }], "2026-10-18");
  expect(r.map((x) => x.variantId)).toEqual(["v"]);
  expect(r[0].valueCents).toBe(10000);
});

describe("Beleg-Erkennung → Formular", () => {
  const today = "2026-10-18";
  it("Meta Irland: EU-Leistung, Land aus USt-IdNr., Nettobetrag", () => {
    const s = mapReceipt({ is_invoice: true, vendor_name: "Meta Platforms Ireland Ltd.", vendor_country: "", vendor_vat_id: "IE 9692928F", invoice_number: "FBADS-1", invoice_date: "2026-10-05", currency: "EUR", total_gross: 250, total_net: 250, total_vat: 0, vat_rate_percent: 0, reverse_charge: true, is_goods: false, category: "ADVERTISING", already_paid: true, payment_method: "CARD" }, today);
    expect(s).toMatchObject({ vendorCountry: "IE", vendorVatId: "IE9692928F", taxCase: "EU_SERVICE", vatRateBp: 1900, amount: "250,00", category: "ADVERTISING", paid: true, paymentMethod: "CARD", date: "2026-10-05" });
    expect(s.warnings).toEqual([]);
  });
  it("deutsche Rechnung 19 %: Bruttobetrag", () => {
    const s = mapReceipt({ vendor_name: "DHL", vendor_country: "DE", total_gross: 59.5, total_net: 50, total_vat: 9.5, vat_rate_percent: 19, currency: "EUR", invoice_date: "2026-10-10", category: "SHIPPING" }, today);
    expect(s).toMatchObject({ taxCase: "DOMESTIC", vatRateBp: 1900, amount: "59,50" });
  });
  it("niederländische MwSt. ausgewiesen → ohne Vorsteuer, Hinweis", () => {
    const s = mapReceipt({ vendor_name: "Kapper BV", vendor_country: "NL", total_gross: 121, total_net: 100, total_vat: 21, vat_rate_percent: 21, currency: "EUR", invoice_date: "2026-10-10", is_goods: true, category: "GOODS" }, today);
    expect(s).toMatchObject({ taxCase: "NO_VAT", vatRateBp: 0, amount: "121,00" });
    expect(s.warnings[0].code).toBe("foreignVat");
  });
  it("Fremdwährung → Betrag leer + Hinweis; Datum in der Zukunft → heute", () => {
    const s = mapReceipt({ vendor_name: "Canva", vendor_country: "US", total_gross: 12, currency: "USD", invoice_date: "2027-05-01", category: "SOFTWARE", is_goods: false }, today);
    expect(s).toMatchObject({ taxCase: "NON_EU_SERVICE", amount: "", date: today });
    expect(s.warnings.map((w) => w.code)).toEqual(["dateGuessed", "foreignCurrency"]);
  });
  it("Ware aus EU ohne MwSt. → innergemeinschaftlicher Erwerb", () => {
    expect(mapReceipt({ vendor_vat_id: "NL123456789B01", total_net: 800, total_gross: 800, is_goods: true, category: "GOODS", currency: "EUR", invoice_date: "2026-10-01" }, today))
      .toMatchObject({ vendorCountry: "NL", taxCase: "EU_GOODS", amount: "800,00" });
  });
});

describe("Monatsbericht in Klartext", () => {
  const t = { revenue: "Umsatz {v}.", revenueDelta: "({d})", margin: "RE {v} {m}.", bestChannel: "Bester {c} {v}.", topCost: "Kosten {c} {v} {p}.", profit: "Gewinn {v}.", loss: "Verlust {v}.", losses: "Bruch {v}.", overdue: "Überfällig {v}.", reorder: "{n} bestellen.", expiry: "Ablauf {v}.", empty: "Leer." };
  const rep = (rev: number, profit: number) => ({ month: "2026-10", from: "", to: "", channels: [{ channel: "STORE", revenueNet: rev, contribution: rev / 2 }, { channel: "BRAND_SHOP", revenueNet: 100, contribution: -50 }],
    totals: { revenueNet: rev, cogs: 0, grossProfit: rev / 2, marginBp: 5000, expenses: 400, losses: 0, profit, goodsPurchases: 0 },
    expensesByCategory: [{ category: "ADVERTISING", net: 300, vat: 0, count: 1 }], lossCount: 0, vat: {}, payments: [] }) as never;
  it("mit Vergleich, bestem Kanal, Kosten und Hinweisen", () => {
    const s = narrative(rep(1000, 100), rep(800, 50), { t, channelName: (c) => c, categoryName: (c) => c, money: (v) => `${v}`, overdueCents: 5, reorderUrgent: 2, expiryRiskCents: 0 });
    expect(s).toEqual(["Umsatz 1000. (+25,0 %)", "RE 500 50,0 %.", "Bester STORE 500.", "Kosten ADVERTISING 300 75,0 %.", "Gewinn 100.", "Überfällig 5.", "2 bestellen."]);
  });
});
