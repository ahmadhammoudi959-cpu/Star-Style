/**
 * Versand mit Sendungsnummer → Shopify (Wunsch Inhaber 12.11.2026). Datenbank + simuliertes Shopify (fetch).
 * Eigener Kanal GENERAL_SHOP, damit der Test nicht mit tests/shopify.test.ts (BRAND_SHOP) kollidiert.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ShopOrder } from "../src/lib/shopify/order-map";

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Versand: Sendung speichern und an Shopify melden", async () => {
  const { db, schema } = await import("../src/db");
  const { encrypt } = await import("../src/lib/crypto");
  const { receiveGoods } = await import("../src/lib/stock");
  const { saveInvoiceDraft, issueInvoice, startCorrection } = await import("../src/lib/sales");
  const sh = await import("../src/lib/shipments");
  const orderId = `gid://shopify/Order/${Date.now()}`;
  let invoiceId = "", variantId = "", customerId = "";
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let mode: "ok" | "scope" | "offline" = "ok";
  let remaining = 3;

  function mock() {
    return vi.fn(async (url: string, init: { body: string | URLSearchParams }) => {
      if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", scope: "x", expires_in: 86399 }));
      if (mode === "offline") throw new TypeError("fetch failed");
      const { query, variables } = JSON.parse(String(init.body));
      calls.push({ query, variables });
      if (mode === "scope") return Response.json({ errors: [{ message: "Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
      if (query.includes("fulfillmentOrders(")) return Response.json({ data: { order: { id: orderId, name: "#2001", fulfillmentOrders: { nodes: [{
        id: "gid://shopify/FulfillmentOrder/1", status: "OPEN", assignedLocation: { location: { id: "gid://shopify/Location/1" } }, supportedActions: [{ action: "CREATE_FULFILLMENT" }],
        lineItems: { nodes: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", remainingQuantity: remaining, lineItem: { id: "gid://shopify/LineItem/11" } }] },
      }] } } } });
      if (query.includes("fulfillmentCreate")) return Response.json({ data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/500", status: "SUCCESS" }, userErrors: [] } } });
      if (query.includes("fulfillmentTrackingInfoUpdate")) return Response.json({ data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: variables.id }, userErrors: [] } } });
      if (query.includes("fulfillmentCancel")) return Response.json({ data: { fulfillmentCancel: { fulfillment: { id: variables.id, status: "CANCELLED" }, userErrors: [] } } });
      return Response.json({ errors: [{ message: "unexpected" }] });
    });
  }
  const shipment = async (id: string) => (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) }))!;
  const setShop = (active: boolean) => db.update(schema.shops).set({ active }).where(eq(schema.shops.channel, "GENERAL_SHOP"));

  beforeAll(async () => {
    const [p] = await db.insert(schema.products).values({ sku: "SHIP-" + Date.now(), nameDe: "Rasiergel 500 ml", vatRateBp: 1900 }).returning();
    variantId = (await db.insert(schema.variants).values({ productId: p.id }).returning())[0].id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId, qty: 10, unitCostCents: 300 }] });
    customerId = (await db.insert(schema.customers).values({ name: "Salon Versand", email: `versand${Date.now()}@example.com` }).returning())[0].id;
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1", active: true })
      .onConflictDoUpdate({ target: schema.shops.channel, set: { domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1", active: true } });
    const draft = await saveInvoiceDraft({
      customerId, channel: "GENERAL_SHOP", discountBp: 0, notes: "Shop-Bestellung #2001", deliveryDate: "2026-11-12", retentionOfTitle: false, pricesGross: true,
      externalOrderId: orderId, taxOverride: { mode: "DOMESTIC", ossCountry: null },
      lines: [
        { variantId, description: "Rasiergel 500 ml", qty: 3, unitPriceCents: 799, discountBp: 0, vatRateBp: 1900, externalLineId: "gid://shopify/LineItem/11" },
        { variantId: null, description: "Versand DHL", qty: 1, unitPriceCents: 590, discountBp: 0, vatRateBp: 1900, externalLineId: "shipping" },
      ],
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    invoiceId = draft;
  });
  afterEach(() => { vi.unstubAllGlobals(); mode = "ok"; });

  it("Shop-Bestellung erscheint unter „Zu versenden“", async () => {
    expect((await sh.shopOrdersToShip()).map((x) => x.id)).toContain(invoiceId);
    expect((await sh.shippingStates([invoiceId])).get(invoiceId)).toBe("none");
  });

  it("App-Recht fehlt → bleibt vorgemerkt (needScope), Shop aus → syncOff, Shop weg → wird wiederholt", async () => {
    vi.stubGlobal("fetch", mock());
    const id = await sh.createShipment({ invoiceId, carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["0034 0434 1610 9404 2557"], notify: true, pick: null });
    mode = "scope";
    expect(await sh.syncShipment(id)).toMatchObject({ shopStatus: "pending", shopError: "needScope" });
    const ev = await db.select().from(schema.shopEvents).where(and(eq(schema.shopEvents.channel, "GENERAL_SHOP"), eq(schema.shopEvents.message, "needScopeFulfillment")));
    expect(ev.length).toBeGreaterThan(0);
    mode = "offline";
    expect(await sh.syncShipment(id)).toMatchObject({ shopStatus: "pending", shopError: "network" });
    await setShop(false);
    expect(await sh.syncShipment(id)).toMatchObject({ shopStatus: "pending", shopError: "syncOff" });
    await setShop(true);
    // aufräumen: vor dem Melden zurücknehmen (war nie im Shop → sofort zurückgenommen)
    await sh.cancelShipment(id);
    expect(await shipment(id)).toMatchObject({ shopStatus: "cancelled", shopFulfillmentIds: [] });
    expect((await shipment(id)).cancelledAt).not.toBeNull();
  }, 30_000);

  it("Sendung mit 2 Paketen → fulfillmentCreate mit DHL, Nummern, Links, E-Mail an den Kunden; danach „Versendet“", async () => {
    vi.stubGlobal("fetch", mock());
    calls.length = 0;
    const id = await sh.createShipment({ invoiceId, carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["00340434161094042557", "00340434161094042558"], notify: true, pick: null });
    expect(await shipment(id)).toMatchObject({ shopStatus: "pending", items: [expect.objectContaining({ externalLineId: "gid://shopify/LineItem/11", qty: 3 })] });
    const s = await sh.syncShipment(id);
    expect(s).toMatchObject({ shopStatus: "sent", shopError: "", shopFulfillmentIds: ["gid://shopify/Fulfillment/500"] });
    const create = calls.find((c) => c.query.includes("fulfillmentCreate"))!;
    expect(create.variables.f).toEqual({
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1", fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 3 }] }],
      notifyCustomer: true,
      trackingInfo: { company: "DHL", numbers: ["00340434161094042557", "00340434161094042558"], urls: [
        "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042557",
        "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042558"] },
    });
    expect((await sh.shippingStates([invoiceId])).get(invoiceId)).toBe("done");
    expect((await sh.shopOrdersToShip()).map((x) => x.id)).not.toContain(invoiceId);
    // nichts mehr offen → zweite Sendung wird abgelehnt
    await expect(sh.createShipment({ invoiceId, carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["00340434161094049999"], notify: true, pick: null }))
      .rejects.toMatchObject({ code: "nothingOpen" });
    // im Protokoll: Nummern + „Kunde informiert“
    const log = await db.select().from(schema.shopEvents).where(and(eq(schema.shopEvents.invoiceId, invoiceId), eq(schema.shopEvents.kind, "shipment")));
    expect(log.map((e) => e.message)).toContain("shipped:DHL 00340434161094042557 00340434161094042558|1");
  }, 30_000);

  it("Tippfehler korrigieren → fulfillmentTrackingInfoUpdate; Webhook danach legt keine doppelte Sendung an", async () => {
    vi.stubGlobal("fetch", mock());
    const s = (await db.select().from(schema.shipments).where(and(eq(schema.shipments.invoiceId, invoiceId), eq(schema.shipments.shopStatus, "sent"))))[0];
    calls.length = 0;
    await sh.editShipment(s.id, { carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["00340434161094042557", "00340434161094042559"], notify: true });
    expect(await shipment(s.id)).toMatchObject({ shopStatus: "update" });
    expect(await sh.syncShipment(s.id)).toMatchObject({ shopStatus: "sent", trackingNumbers: ["00340434161094042557", "00340434161094042559"] });
    const upd = calls.find((c) => c.query.includes("fulfillmentTrackingInfoUpdate"))!;
    expect(upd.variables).toMatchObject({ id: "gid://shopify/Fulfillment/500", notify: true, t: { company: "DHL", numbers: ["00340434161094042557", "00340434161094042559"] } });
    // Bestell-Abgleich mit unserem Fulfillment + Zustellstatus, dazu eine im Shopify-Admin angelegte GLS-Sendung
    const o = { id: orderId, name: "#2001", fulfillments: [
      { id: "gid://shopify/Fulfillment/500", status: "SUCCESS", displayStatus: "IN_TRANSIT", createdAt: "2026-11-12T10:00:00Z", trackingInfo: [{ company: "DHL", number: "00340434161094042557", url: null }], fulfillmentLineItems: { nodes: [{ quantity: 3, lineItem: { id: "gid://shopify/LineItem/11" } }] } },
      { id: "gid://shopify/Fulfillment/501", status: "SUCCESS", displayStatus: null, createdAt: "2026-11-12T11:00:00Z", trackingInfo: [{ company: "GLS", number: "ZZ12345678", url: "https://gls-group.com/DE/de/paketverfolgung?match=ZZ12345678" }], fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/11" } }] } },
    ] } as unknown as ShopOrder;
    await sh.importShopFulfillments("GENERAL_SHOP", o, invoiceId);
    await sh.importShopFulfillments("GENERAL_SHOP", o, invoiceId); // zweimal (Webhook + Abgleich) → nichts doppelt
    const all = await db.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, invoiceId));
    expect(all.find((x) => x.id === s.id)).toMatchObject({ deliveryStatus: "IN_TRANSIT" });
    const fromShop = all.filter((x) => x.source === "shop");
    expect(fromShop).toHaveLength(1);
    expect(fromShop[0]).toMatchObject({ carrier: "GLS", trackingNumbers: ["ZZ12345678"], shopStatus: "sent", shopFulfillmentIds: ["gid://shopify/Fulfillment/501"], shippedOn: "2026-11-12" });
    // im Shopify-Admin storniert → bei uns zurückgenommen
    await sh.importShopFulfillments("GENERAL_SHOP", { ...o, fulfillments: [{ ...o.fulfillments![1], status: "CANCELLED" }] } as ShopOrder, invoiceId);
    expect((await shipment(fromShop[0].id)).cancelledAt).not.toBeNull();
  }, 30_000);

  it("Teil-Erstattung (Korrektur): Sendungen wandern mit auf die neue Rechnung", async () => {
    const draft = await startCorrection(invoiceId);
    await saveInvoiceDraft({
      id: draft, customerId, replacesInvoiceId: invoiceId, channel: "GENERAL_SHOP", discountBp: 0, notes: "Teil-Erstattung", deliveryDate: "2026-11-12", retentionOfTitle: false,
      pricesGross: true, externalOrderId: orderId, taxOverride: { mode: "DOMESTIC", ossCountry: null },
      lines: [{ variantId, description: "Rasiergel 500 ml", qty: 2, unitPriceCents: 799, discountBp: 0, vatRateBp: 1900, externalLineId: "gid://shopify/LineItem/11" }],
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    const moved = await db.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, draft));
    expect(moved.length).toBeGreaterThanOrEqual(2);
    const newLine = (await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, draft)))[0];
    expect(moved.filter((m) => !m.cancelledAt).flatMap((m) => m.items).every((i) => i.lineId === newLine.id)).toBe(true);
    expect((await sh.shippingStates([draft])).get(draft)).toBe("done");
    invoiceId = draft;
  }, 30_000);

  it("Zurücknehmen → fulfillmentCancel; Bestellung wieder „Zu versenden“", async () => {
    vi.stubGlobal("fetch", mock());
    const s = (await db.select().from(schema.shipments).where(and(eq(schema.shipments.invoiceId, invoiceId), eq(schema.shipments.source, "system"), eq(schema.shipments.shopStatus, "sent"))))[0];
    calls.length = 0;
    await sh.cancelShipment(s.id);
    expect(await shipment(s.id)).toMatchObject({ shopStatus: "cancel" });
    expect(await sh.syncShipment(s.id)).toMatchObject({ shopStatus: "cancelled" });
    expect(calls.find((c) => c.query.includes("fulfillmentCancel"))!.variables).toEqual({ id: "gid://shopify/Fulfillment/500" });
    expect((await shipment(s.id)).cancelledAt).not.toBeNull();
    expect((await sh.shopOrdersToShip()).map((x) => x.id)).toContain(invoiceId);
    // Spedition ohne Nummer, Teilmenge, ohne E-Mail
    remaining = 2;
    const line = (await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)))[0];
    const id = await sh.createShipment({ invoiceId, carrier: "OTHER", carrierName: "Möbel Express", trackingUrl: "https://moebel.example/t?n={n}", numbers: [], notify: false, pick: { [line.id]: 1 } });
    calls.length = 0;
    expect(await sh.syncShipment(id)).toMatchObject({ shopStatus: "sent" });
    expect(calls.find((c) => c.query.includes("fulfillmentCreate"))!.variables.f).toMatchObject({
      notifyCustomer: false, trackingInfo: { company: "Möbel Express" },
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1", fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 1 }] }],
    });
    expect((await sh.shippingStates([invoiceId])).get(invoiceId)).toBe("partial");
    // Eingaben prüfen
    await expect(sh.createShipment({ invoiceId, carrier: "DHL", carrierName: "", trackingUrl: "", numbers: [], notify: true, pick: null })).rejects.toMatchObject({ code: "missing" });
    await expect(sh.createShipment({ invoiceId, carrier: "OTHER", carrierName: " ", trackingUrl: "", numbers: [], notify: true, pick: null })).rejects.toMatchObject({ code: "carrierName" });
    await expect(sh.createShipment({ invoiceId, carrier: "OTHER", carrierName: "X", trackingUrl: "http://unsicher.example", numbers: [], notify: true, pick: null })).rejects.toMatchObject({ code: "url" });
    await expect(sh.createShipment({ invoiceId, carrier: "FEDEX", carrierName: "", trackingUrl: "", numbers: ["123456"], notify: true, pick: null })).rejects.toMatchObject({ code: "carrier" });
    // jede Änderung im Protokoll
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entity, "shipment"), eq(schema.auditLog.entityId, id)));
    expect(audit.map((a) => a.action)).toContain("create");
  }, 30_000);
});
