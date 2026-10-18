import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { computeTotals } from "../src/lib/tax";
import { mapOrder, quantitiesAfterRefund, type ShopOrder } from "../src/lib/shopify/order-map";
import { verifyHmac } from "../src/lib/shopify/webhooks";

const money = (a: number) => ({ shopMoney: { amount: a.toFixed(2) } });
function order(p: Partial<ShopOrder> = {}): ShopOrder {
  return {
    id: "gid://shopify/Order/1", name: "#1001", createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z", processedAt: "2026-10-18T10:00:00Z",
    cancelledAt: null, test: false, email: "Kunde@Example.de", currencyCode: "EUR", taxesIncluded: true, displayFinancialStatus: "PAID", paymentGatewayNames: ["shopify_payments"],
    billingAddress: { firstName: "Max", lastName: "Muster", company: "", address1: "Hauptstr. 1", zip: "45711", city: "Datteln", countryCodeV2: "DE" },
    shippingAddress: { firstName: "Max", lastName: "Muster", company: "", address1: "Hauptstr. 1", zip: "45711", city: "Datteln", countryCodeV2: "DE" },
    totalPriceSet: money(64.85), currentTotalPriceSet: money(64.85), totalRefundedSet: money(0),
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/11", sku: "SH-200", title: "Rasiergel", variantTitle: "500 ml", quantity: 3, variant: { id: "gid://shopify/ProductVariant/21" }, discountedUnitPriceAfterAllDiscountsSet: money(7.99), taxLines: [{ rate: 0.19 }] },
      { id: "gid://shopify/LineItem/12", sku: "BUCH", title: "Fachbuch", variantTitle: null, quantity: 1, variant: { id: "gid://shopify/ProductVariant/22" }, discountedUnitPriceAfterAllDiscountsSet: money(35), taxLines: [{ rate: 0.07 }] },
    ] },
    shippingLines: { nodes: [{ title: "DHL", discountedPriceSet: money(5.88), taxLines: [{ rate: 0.19 }] }] },
    refunds: [], ...p,
  };
}

describe("Bruttopreise", () => {
  it("Endbetrag bleibt exakt, USt je Satz herausgerechnet", () => {
    const t = computeTotals([
      { qty: 3, unitPriceCents: 799, discountBp: 0, vatRateBp: 1900 },
      { qty: 1, unitPriceCents: 3500, discountBp: 0, vatRateBp: 700 },
      { qty: 1, unitPriceCents: 588, discountBp: 0, vatRateBp: 1900 },
    ], 0, { gross: true });
    expect(t.grossCents).toBe(6485);
    expect(t.vatByRate).toEqual([{ rateBp: 1900, netCents: 2508, vatCents: 477 }, { rateBp: 700, netCents: 3271, vatCents: 229 }]);
    expect(t.lines.reduce((s, l) => s + l.netCents + l.vatCents, 0)).toBe(6485);
  });
});

describe("Shopify-Bestellung → Rechnung", () => {
  const links = new Map([["gid://shopify/ProductVariant/21", "v-gel"]]);
  it("Inland, Bruttopreise, Versand als Position, nicht zugeordnete Variante gemeldet", () => {
    const m = mapOrder(order(), links);
    expect(m).toMatchObject({ taxMode: "DOMESTIC", ossCountry: null, pricesGross: true, paid: true, skip: null, totalCents: 6485, computedCents: 6485, date: "2026-10-18" });
    expect(m.customer).toMatchObject({ name: "Max Muster", email: "kunde@example.de", type: "PERSON", country: "DE" });
    expect(m.lines.map((l) => [l.variantId, l.qty, l.unitPriceCents, l.vatRateBp, l.externalLineId])).toEqual([
      ["v-gel", 3, 799, 1900, "gid://shopify/LineItem/11"], [null, 1, 3500, 700, "gid://shopify/LineItem/12"], [null, 1, 588, 1900, "shipping"]]);
    expect(m.unmapped).toEqual(["Fachbuch · BUCH"]);
  });
  it("Niederlande mit 21 % → OSS; mit 19 % → EU-Privatkunde ohne OSS", () => {
    const nl = { firstName: "Jan", lastName: "Jansen", company: "", address1: "Straat 1", zip: "1011", city: "Amsterdam", countryCodeV2: "NL" };
    const o = order({ shippingAddress: nl, billingAddress: nl, lineItems: { nodes: [{ ...order().lineItems.nodes[0], taxLines: [{ rate: 0.21 }] }] }, shippingLines: { nodes: [] }, totalPriceSet: money(23.97) });
    expect(mapOrder(o, links)).toMatchObject({ taxMode: "EU_B2C", ossCountry: "NL" });
    expect(mapOrder({ ...o, lineItems: { nodes: [order().lineItems.nodes[0]] } }, links)).toMatchObject({ taxMode: "EU_B2C", ossCountry: null });
  });
  it("steuerfrei in die EU → nicht automatisch (USt-IdNr. prüfen); Schweiz → Ausfuhr", () => {
    const at = { firstName: "", lastName: "", company: "Salon Wien GmbH", address1: "Ring 1", zip: "1010", city: "Wien", countryCodeV2: "AT" };
    const noTax = { nodes: [{ ...order().lineItems.nodes[0], taxLines: [] }] };
    expect(mapOrder(order({ shippingAddress: at, billingAddress: at, lineItems: noTax, shippingLines: { nodes: [] } }), links).skip).toBe("noTaxEu");
    const ch = { ...at, countryCodeV2: "CH" };
    expect(mapOrder(order({ shippingAddress: ch, billingAddress: ch, lineItems: noTax, shippingLines: { nodes: [] }, totalPriceSet: money(23.97) }), links)).toMatchObject({ taxMode: "EXPORT", skip: null, customer: { type: "COMPANY", name: "Salon Wien GmbH" } });
  });
  it("Fremdwährung wird nicht automatisch gebucht", () => {
    expect(mapOrder(order({ currencyCode: "CHF" }), links).skip).toBe("currency");
  });
  it("Restmengen nach Teil-Erstattung", () => {
    const r = { id: "r1", createdAt: "", totalRefundedSet: money(7.99), refundLineItems: { nodes: [{ quantity: 1, restockType: "RETURN", lineItem: { id: "L1" } }] } };
    expect(quantitiesAfterRefund([{ externalLineId: "L1", qty: 3 }, { externalLineId: "shipping", qty: 1 }], r)).toEqual([{ externalLineId: "L1", qty: 2 }, { externalLineId: "shipping", qty: 1 }]);
  });
  it("Webhook-Echtheit (HMAC)", () => {
    const body = '{"id":1}';
    const sig = createHmac("sha256", "geheim").update(body).digest("base64");
    expect(verifyHmac(body, "geheim", sig)).toBe(true);
    expect(verifyHmac(body + " ", "geheim", sig)).toBe(false);
    expect(verifyHmac(body, "geheim", null)).toBe(false);
  });
});

// ───────────── Integration mit simuliertem Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Shopify-Abgleich (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { encrypt } = await import("../src/lib/crypto");
  const { receiveGoods } = await import("../src/lib/stock");
  const sync = await import("../src/lib/shopify/sync");
  const { paymentState } = await import("../src/lib/payment-status");
  const ean = "40" + String(Date.now()).slice(-11);
  let variantId = "";
  const calls: { url: string; body: string }[] = [];
  let ordersPayload: ShopOrder[] = [];

  function shopifyMock() {
    return vi.fn(async (url: string, init: { body: string | URLSearchParams }) => {
      const body = String(init.body);
      calls.push({ url, body });
      if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", scope: "x", expires_in: 86399 }));
      const q = JSON.parse(body).query as string;
      if (q.includes("productVariants")) return Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [
        { id: "gid://shopify/ProductVariant/901", sku: "X", barcode: ean, displayName: "Haarspray - 300 ml", inventoryItem: { id: "gid://shopify/InventoryItem/701", tracked: true } },
        { id: "gid://shopify/ProductVariant/902", sku: "UNBEKANNT", barcode: "", displayName: "Geschenkkarte", inventoryItem: { id: "gid://shopify/InventoryItem/702", tracked: false } },
      ] } } });
      if (q.includes("inventorySetQuantities")) return Response.json({ data: { inventorySetQuantities: { userErrors: [] } } });
      if (q.includes("orders(")) return Response.json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: ordersPayload } } });
      return Response.json({ errors: [{ message: "unexpected" }] });
    });
  }

  beforeAll(async () => {
    const [p] = await db.insert(schema.products).values({ sku: "HS-" + ean.slice(-5), nameDe: "Haarspray", vatRateBp: 1900 }).returning();
    variantId = (await db.insert(schema.variants).values({ productId: p.id, barcode: ean }).returning())[0].id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId, qty: 20, unitCostCents: 250 }] });
    await db.delete(schema.shopVariants).where(eq(schema.shopVariants.channel, "BRAND_SHOP"));
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", domain: "star-brand.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), locationId: "gid://shopify/Location/1", active: true })
      .onConflictDoUpdate({ target: schema.shops.channel, set: { domain: "star-brand.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), locationId: "gid://shopify/Location/1", active: true, stockBuffer: 0, importTestOrders: false, staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null, lastOrderSync: null, ordersSince: null } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Produkte laden und per Barcode zuordnen, Bestand melden (nur Änderungen)", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const r = await sync.syncProducts("BRAND_SHOP");
    expect(r).toMatchObject({ total: 2, matched: 1, open: 0 }); // Geschenkkarte ohne Bestandsführung zählt nicht als offen
    const p1 = await sync.pushStock("BRAND_SHOP");
    expect(p1.pushed).toBe(1);
    const sent = JSON.parse(calls.filter((c) => c.body.includes("inventorySetQuantities")).at(-1)!.body);
    expect(sent.variables.input.quantities[0]).toEqual({ inventoryItemId: "gid://shopify/InventoryItem/701", locationId: "gid://shopify/Location/1", quantity: 20, changeFromQuantity: null });
    expect(sent.variables.key).toMatch(/^[0-9a-f-]{36}$/);
    expect((await sync.pushStock("BRAND_SHOP")).pushed).toBe(0);
    expect(calls.filter((c) => c.url.endsWith("access_token"))).toHaveLength(1); // Token wird zwischengespeichert
  });

  it("Bestellung → Rechnung bezahlt, Bestand runter; Teil-Erstattung → Korrektur; Storno → alles zurück", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const base = order({ id: "gid://shopify/Order/" + ean, name: "#" + ean.slice(-4), email: `k${ean}@test.de`,
      lineItems: { nodes: [{ id: "gid://shopify/LineItem/a" + ean, sku: "X", title: "Haarspray", variantTitle: "300 ml", quantity: 4, variant: { id: "gid://shopify/ProductVariant/901" }, discountedUnitPriceAfterAllDiscountsSet: money(9.99), taxLines: [{ rate: 0.19 }] }] },
      shippingLines: { nodes: [{ title: "DHL", discountedPriceSet: money(4.9), taxLines: [{ rate: 0.19 }] }] }, totalPriceSet: money(44.86), currentTotalPriceSet: money(44.86) });
    ordersPayload = [base];
    await sync.syncOrders("BRAND_SHOP");
    let inv = await db.query.invoices.findFirst({ where: and(eq(schema.invoices.externalOrderId, base.id), eq(schema.invoices.status, "ISSUED")), with: { payments: true, installments: true } });
    expect(inv).toMatchObject({ channel: "BRAND_SHOP", grossCents: 4486, pricesGross: true, taxLocked: true, taxMode: "DOMESTIC" });
    expect(paymentState(inv!, "2026-10-18").status).toBe("PAID");
    expect((await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) }))!.stockQty).toBe(16);
    expect((await db.select().from(schema.stockDirty).where(eq(schema.stockDirty.variantId, variantId))).length).toBe(1);

    // nochmal abgleichen: keine doppelte Rechnung
    await sync.syncOrders("BRAND_SHOP");
    expect((await db.select().from(schema.invoices).where(eq(schema.invoices.externalOrderId, base.id))).length).toBe(1);

    // Teil-Erstattung: 1 Stück zurück
    ordersPayload = [{ ...base, displayFinancialStatus: "PARTIALLY_REFUNDED", refunds: [{ id: "gid://shopify/Refund/r" + ean, createdAt: "2026-10-18T12:00:00Z", totalRefundedSet: money(9.99),
      refundLineItems: { nodes: [{ quantity: 1, restockType: "RETURN", lineItem: { id: "gid://shopify/LineItem/a" + ean } }] } }] }];
    await sync.syncOrders("BRAND_SHOP");
    inv = await db.query.invoices.findFirst({ where: and(eq(schema.invoices.externalOrderId, base.id), eq(schema.invoices.status, "ISSUED"), eq(schema.invoices.kind, "INVOICE")), with: { payments: true, installments: true } });
    expect(inv!.grossCents).toBe(3487);
    expect(paymentState(inv!, "2026-10-18")).toMatchObject({ status: "PAID", paidCents: 3487 });
    expect((await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) }))!.stockQty).toBe(17);

    // Storno im Shop
    ordersPayload = [{ ...ordersPayload[0], cancelledAt: "2026-10-18T13:00:00Z", displayFinancialStatus: "REFUNDED", totalRefundedSet: money(44.86) }];
    await sync.syncOrders("BRAND_SHOP");
    const all = await db.select().from(schema.invoices).where(eq(schema.invoices.externalOrderId, base.id));
    expect(all.every((i) => i.status === "CANCELLED")).toBe(true);
    expect((await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) }))!.stockQty).toBe(20);
    const events = await db.select().from(schema.shopEvents).where(eq(schema.shopEvents.ref, base.name));
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["order", "refund", "cancel"]));
  }, 30_000);

  it("geänderte Bestände werden automatisch gemeldet und die Warteschlange geleert", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    await sync.processDirty();
    expect((await db.select().from(schema.stockDirty).where(eq(schema.stockDirty.variantId, variantId))).length).toBe(0);
    const sv = await db.query.shopVariants.findFirst({ where: eq(schema.shopVariants.variantId, variantId) });
    expect(sv!.lastPushedQty).toBe(20);
  });
});
