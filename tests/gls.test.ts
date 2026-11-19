/**
 * GLS-Anbindung (ShipIT) + Abholung im Lager (Wunsch Inhaber 13.11.2026).
 * Rein: Anschrift, Gewicht, Anfrage, Antwort, Fehler. DB (mit DATABASE_URL): Etikett erstellen mit simuliertem GLS (fetch),
 * Sendung mit GLS-Nummern + Etikett-PDF, Stornieren bei GLS, Ablehnung, Abholung.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import {
  buildGlsShipment, checkWeights, consigneeProblem, glsCancelOk, glsErrorText, glsReady, glsText, normalizeEndpoint, parseGlsCreated, parseGlsSettings,
  parseKg, splitStreet, suggestParcels, trackingNumberOf,
} from "../src/lib/gls";
import { deliveryMethodOf, type ShopOrder } from "../src/lib/shopify/order-map";

describe("GLS – rein", () => {
  it("Endpoint: nur https, ohne /shipments und / am Ende; http nur lokal im Test", () => {
    expect(normalizeEndpoint(" https://shipit-wbm-de01.gls-group.eu:443/backend/rs/shipments/ ")).toBe("https://shipit-wbm-de01.gls-group.eu:443/backend/rs");
    expect(normalizeEndpoint("http://shipit.gls-group.eu/backend/rs")).toBe("");
    expect(normalizeEndpoint("https://user:pw@gls.example/backend/rs")).toBe("");
    expect(normalizeEndpoint("kein link")).toBe("");
    expect(normalizeEndpoint("http://localhost:9/backend/rs")).toBe("");
    expect(normalizeEndpoint("http://localhost:9/backend/rs", true)).toBe("http://localhost:9/backend/rs");
  });

  it("Einstellungen lesen wirft nie; eingerichtet erst mit allen vier Angaben", () => {
    for (const raw of [null, undefined, 7, "x", [], {}]) expect(parseGlsSettings(raw)).toEqual({ endpoint: "", user: "", password: "", contactId: "", flex: false });
    const s = parseGlsSettings({ endpoint: "https://gls.example/backend/rs", user: " 2764200001 ", password: "v1.a.b.c", contactId: "276a45fkqM", flex: true });
    expect(s).toEqual({ endpoint: "https://gls.example/backend/rs", user: "2764200001", password: "v1.a.b.c", contactId: "276a45fkqM", flex: true });
    expect(glsReady(s)).toBe(true);
    expect(glsReady({ ...s, contactId: "" })).toBe(false);
  });

  it("Straße und Hausnummer trennen", () => {
    expect(splitStreet("Provinzialstraße 45")).toEqual({ street: "Provinzialstraße", number: "45" });
    expect(splitStreet("Am Markt 7 b")).toEqual({ street: "Am Markt", number: "7b" });
    expect(splitStreet("Hauptstr. 12-14")).toEqual({ street: "Hauptstr.", number: "12-14" });
    expect(splitStreet("Straße des 17. Juni 135")).toEqual({ street: "Straße des 17. Juni", number: "135" });
    expect(splitStreet("12 Rue de Rivoli")).toEqual({ street: "Rue de Rivoli", number: "12" });
    expect(splitStreet("Postfach")).toEqual({ street: "Postfach", number: "" });
  });

  it("Text: verbotene Zeichen weg, gekürzt", () => {
    expect(glsText('Salon "Elite" (Herne); {x}|y', 40)).toBe("Salon Elite Herne x y");
    expect(glsText("a".repeat(50), 40)).toHaveLength(40);
  });

  it("Anschrift vollständig?", () => {
    const c = { name: "Salon", street: "Hauptstr. 1", zip: "44623", city: "Herne", country: "DE", business: true };
    expect(consigneeProblem(c)).toBeNull();
    expect(consigneeProblem({ ...c, zip: " " })).toBe("zip");
    expect(consigneeProblem({ ...c, country: "Deutschland" })).toBe("country");
  });

  it("Gewicht: Vorschlag aus der Ware, Grenzen 0,1–40 kg, höchstens 20 Pakete", () => {
    expect(parseKg("1,5")).toBe(1.5);
    expect(parseKg("x")).toBeNull();
    expect(suggestParcels([{ grams: 2500, qty: 2 }])).toEqual({ kgs: [5], unknown: 0, heavy: false });
    expect(suggestParcels([{ grams: null, qty: 3 }, { grams: 500, qty: 1 }])).toEqual({ kgs: [3.5], unknown: 1, heavy: false });
    const big = suggestParcels([{ grams: 20_000, qty: 4 }]); // 80 kg → 3 Pakete
    expect(big.kgs).toEqual([26.7, 26.7, 26.7]);
    expect(suggestParcels([{ grams: 55_000, qty: 1 }]).heavy).toBe(true);
    expect(suggestParcels([]).kgs).toEqual([0.1]);
    expect(checkWeights([5, 3])).toBeNull();
    expect(checkWeights([])).toBe("none");
    expect(checkWeights([0.05])).toBe("tooLight");
    expect(checkWeights([null])).toBe("tooLight");
    expect(checkWeights([41])).toBe("tooHeavy");
    expect(checkWeights(Array(21).fill(1))).toBe("tooMany");
  });

  it("Anfrage an ShipIT: Empfänger, Pakete, Absender, Etikett als PDF; FlexDelivery nur mit E-Mail", () => {
    const body = buildGlsShipment({
      reference: "RE-2026-0007", shippingDate: "2026-11-13", contactId: "276a45fkqM", flex: true, parcelsKg: [2.5, 1],
      consignee: { name: "Barber (Elite) GmbH", contact: "Ali Haaji", street: "Hauptstraße 12a", zip: "44623", city: "Herne", country: "DE", email: "ali@example.com", phone: "+49 170 1234567", business: true },
    });
    expect(body.Shipment).toMatchObject({
      ShipmentReference: ["RE-2026-0007"], ShippingDate: "2026-11-13", Product: "PARCEL", Middleware: "StarStyle", Shipper: { ContactID: "276a45fkqM" },
      Consignee: { Category: "BUSINESS", Address: { Name1: "Barber Elite GmbH", Name2: "Ali Haaji", CountryCode: "DE", ZIPCode: "44623", City: "Herne", Street: "Hauptstraße", StreetNumber: "12a", eMail: "ali@example.com", MobilePhoneNumber: "+49 170 1234567" } },
      ShipmentUnit: [{ Weight: "2.50" }, { Weight: "1.00" }],
      Service: [{ Service: { ServiceName: "service_flexdelivery" } }],
    });
    expect(body.PrintingOptions).toEqual({ ReturnLabels: { TemplateSet: "NONE", LabelFormat: "PDF" } });
    const plain = buildGlsShipment({ reference: "", shippingDate: "2026-11-13", contactId: "X", flex: true, parcelsKg: [1], consignee: { name: "Privat", street: "Postfach", zip: "1", city: "Wien", country: "AT", business: false } });
    expect(plain.Shipment).not.toHaveProperty("Service");
    expect(plain.Shipment).not.toHaveProperty("ShipmentReference");
    expect(plain.Shipment.Consignee).toEqual({ Category: "PRIVATE", Address: { Name1: "Privat", CountryCode: "AT", ZIPCode: "1", City: "Wien", Street: "Postfach" } });
  });

  it("Antwort lesen: Pakete und Etiketten; Nummer = Paketnummer, sonst TrackID", () => {
    const r = parseGlsCreated({ CreatedShipment: { ParcelData: [{ TrackID: "ZDFHG5J3", ParcelNumber: "51234567890" }, { TrackID: "ZDFHG5J4" }], PrintData: [{ Data: "JVBERi0xLjcKJ" + "A".repeat(30), LabelFormat: "PDF" }] } });
    expect(r.parcels).toEqual([{ trackId: "ZDFHG5J3", parcelNumber: "51234567890" }, { trackId: "ZDFHG5J4", parcelNumber: "" }]);
    expect(r.labels).toHaveLength(1);
    expect(r.parcels.map(trackingNumberOf)).toEqual(["51234567890", "ZDFHG5J4"]);
    expect(() => parseGlsCreated({ CreatedShipment: { ParcelData: [] } })).toThrow();
    expect(() => parseGlsCreated("Unsinn")).toThrow();
  });

  it("Fehlertext aus den Kopfzeilen, Storno-Antwort", () => {
    const h = new Headers({ message: "Consignee.Address.ZIPCode invalid", error: "VALIDATION" });
    expect(glsErrorText(400, h, "")).toBe("HTTP 400: Consignee.Address.ZIPCode invalid · VALIDATION");
    expect(glsErrorText(500, new Headers(), "<html><b>Server Error</b></html>")).toBe("HTTP 500: Server Error");
    expect(glsCancelOk({ TrackID: "X", result: "CANCELLED" })).toBe(true);
    expect(glsCancelOk({ result: "CANCELLATION_PENDING" })).toBe(true);
    expect(glsCancelOk({ result: "SCANNED" })).toBe(false);
  });

  it("Abholung im Lager: Lieferart aus den Fulfillment-Aufträgen", () => {
    const o = (types: (string | null)[] | null) => ({ fulfillmentOrders: types ? { nodes: types.map((t) => ({ deliveryMethod: t ? { methodType: t } : null })) } : undefined }) as unknown as ShopOrder;
    expect(deliveryMethodOf(o(["PICK_UP"]))).toBe("PICK_UP");
    expect(deliveryMethodOf(o(["SHIPPING"]))).toBe("");
    expect(deliveryMethodOf(o(["PICK_UP", "SHIPPING"]))).toBe("");
    expect(deliveryMethodOf(o([]))).toBeNull();
    expect(deliveryMethodOf(o(null))).toBeNull();
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("GLS – Etikett aus dem System (DB, simuliertes GLS)", async () => {
  const { db, schema } = await import("../src/db");
  const { receiveGoods } = await import("../src/lib/stock");
  const { saveInvoiceDraft, issueInvoice } = await import("../src/lib/sales");
  const { saveGlsSettings, loadGlsSettings, glsTestConnection } = await import("../src/lib/gls-client");
  const { fileNeed } = await import("../src/lib/file-access");
  const sh = await import("../src/lib/shipments");
  let invoiceId = "", variantId = "";
  let label = "";
  const calls: { url: string; auth: string; body: unknown }[] = [];
  let mode: "ok" | "reject" | "cancelRefused" = "ok";
  let n = 0;

  const mock = () => vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/shipments/validate")) return Response.json({ success: true, validationResult: { Issues: [] } });
    if (url.includes("/shipments/cancel/")) {
      return mode === "cancelRefused" ? Response.json({ TrackID: url.split("/").pop(), result: "SCANNED" }) : Response.json({ TrackID: url.split("/").pop(), result: "CANCELLED" });
    }
    if (url.endsWith("/shipments")) {
      if (mode === "reject") return new Response("", { status: 400, headers: { message: "Consignee.Address.ZIPCode invalid", error: "VALIDATION" } });
      const units = (JSON.parse(init.body!) as { Shipment: { ShipmentUnit: unknown[] } }).Shipment.ShipmentUnit;
      n++;
      return Response.json({ CreatedShipment: {
        ParcelData: units.map((_, i) => ({ TrackID: `TRK${n}${i}AB`, ParcelNumber: `5100000${n}${i}` })),
        PrintData: [{ Data: label, LabelFormat: "PDF" }],
      } });
    }
    return new Response("not found", { status: 404 });
  });

  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([283, 425]);
    label = Buffer.from(await pdf.save()).toString("base64");
    const [p] = await db.insert(schema.products).values({ sku: "GLS-" + Date.now(), nameDe: "Haarschneidemaschine", vatRateBp: 1900 }).returning();
    variantId = (await db.insert(schema.variants).values({ productId: p.id, weightGrams: 1200 }).returning())[0].id;
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId, qty: 10, unitCostCents: 3000 }] });
    const [c] = await db.insert(schema.customers).values({
      name: "Barber Elite", contact: "Ali Haaji", email: `gls${Date.now()}@example.com`, phone: "+49 170 1234567", street: "Hauptstraße 12a", zip: "44623", city: "Herne", country: "DE",
    }).returning();
    const draft = await saveInvoiceDraft({
      customerId: c.id, channel: "STORE", discountBp: 0, notes: "", deliveryDate: "2026-11-13", retentionOfTitle: false, pricesGross: false,
      lines: [{ variantId, description: "Haarschneidemaschine", qty: 3, unitPriceCents: 5000, discountBp: 0, vatRateBp: 1900 }],
    });
    await issueInvoice(draft);
    invoiceId = draft;
    vi.stubGlobal("fetch", mock());
    expect(await saveGlsSettings({ endpoint: "http://localhost:9/backend/rs/", user: "2764200001", password: "geheim-123", contactId: "276a45fkqM", flex: false })).toEqual({ ok: true });
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.unstubAllGlobals(); mode = "ok"; });

  it("Einstellungen: Passwort nur verschlüsselt, leer = altes bleibt; Pflichtfelder", async () => {
    const s = await loadGlsSettings();
    expect(s.endpoint).toBe("http://localhost:9/backend/rs");
    expect(s.password.startsWith("v1.")).toBe(true);
    expect(s.password).not.toContain("geheim");
    expect(await saveGlsSettings({ endpoint: s.endpoint, user: "2764200001", password: "", contactId: "276a45fkqM", flex: true })).toEqual({ ok: true });
    expect((await loadGlsSettings()).password).toBe(s.password);
    expect(await saveGlsSettings({ endpoint: "http://gls.example", user: "u", password: "", contactId: "c", flex: false })).toEqual({ problem: "endpoint" });
    expect(await saveGlsSettings({ endpoint: s.endpoint, user: "", password: "", contactId: "c", flex: false })).toEqual({ problem: "user" });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, "gls"));
    expect(JSON.stringify(audit)).not.toContain("geheim");
    await saveGlsSettings({ endpoint: s.endpoint, user: "2764200001", password: "", contactId: "276a45fkqM", flex: false });
  });

  it("Verbindung testen = nur prüfen (validate), Basic-Auth mit dem entschlüsselten Passwort", async () => {
    vi.stubGlobal("fetch", mock());
    expect(await glsTestConnection()).toEqual({ ok: true });
    const c = calls.at(-1)!;
    expect(c.url).toBe("http://localhost:9/backend/rs/shipments/validate");
    expect(c.auth).toBe(`Basic ${Buffer.from("2764200001:geheim-123").toString("base64")}`);
  });

  it("Etikett erstellen: GLS-Nummern an der Sendung, Etikett-PDF gespeichert, Anschrift aus der Rechnung", async () => {
    vi.stubGlobal("fetch", mock());
    const id = await sh.createGlsShipment({ invoiceId, parcelsKg: [2.5, 1.1], pick: { [(await lineId())]: 2 }, notify: false, note: "2 Kartons" });
    const s = (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) }))!;
    expect(s).toMatchObject({ carrier: "GLS", glsStatus: "created", note: "2 Kartons", shopStatus: "none" });
    expect(s.trackingNumbers).toHaveLength(2);
    expect(s.glsTrackIds).toHaveLength(2);
    expect(s.items).toMatchObject([{ qty: 2 }]);
    const f = (await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, s.labelFileId!) }))!;
    expect(f.mime).toBe("application/pdf");
    expect(f.data.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(await fileNeed(f.id)).toEqual(expect.arrayContaining(["sales.shipping"]));
    const req = calls.at(-1)!.body as { Shipment: { Consignee: { Address: Record<string, string> }; ShipmentUnit: { Weight: string }[] } };
    expect(req.Shipment.Consignee.Address).toMatchObject({ Name1: "Barber Elite", Street: "Hauptstraße", StreetNumber: "12a", ZIPCode: "44623", City: "Herne", CountryCode: "DE" });
    expect(req.Shipment.ShipmentUnit.map((u) => u.Weight)).toEqual(["2.50", "1.10"]);
    // ohne Einwilligung des Kunden bekommt GLS weder E-Mail noch Telefon (GLS-Vertrag 19.11.2026)
    expect(req.Shipment.Consignee.Address).not.toHaveProperty("eMail");
    expect(req.Shipment.Consignee.Address).not.toHaveProperty("MobilePhoneNumber");
    expect(s.glsContactConsent).toBe(false);
    // GLS-Etikett: Nummer nicht änderbar
    await expect(sh.editShipment(id, { carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["00340434161094042557"], notify: false })).rejects.toMatchObject({ code: "glsLocked" });
  });

  it("GLS lehnt ab → keine Sendung; Gewicht zu hoch → gar nicht erst bei GLS", async () => {
    vi.stubGlobal("fetch", mock());
    const before = calls.length;
    await expect(sh.createGlsShipment({ invoiceId, parcelsKg: [41], pick: null, notify: false })).rejects.toMatchObject({ code: "weight_tooHeavy" });
    expect(calls.length).toBe(before);
    mode = "reject";
    await expect(sh.createGlsShipment({ invoiceId, parcelsKg: [1], pick: null, notify: false })).rejects.toMatchObject({ code: "gls_rejected", detail: expect.stringContaining("ZIPCode") });
    expect((await db.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, invoiceId))).length).toBe(1);
  });

  it("Zurücknehmen storniert bei GLS; lehnt GLS ab, bleibt die Sendung", async () => {
    vi.stubGlobal("fetch", mock());
    const s = (await db.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, invoiceId)))[0];
    mode = "cancelRefused";
    await expect(sh.cancelShipment(s.id)).rejects.toMatchObject({ code: "glsCancel" });
    expect((await db.query.shipments.findFirst({ where: eq(schema.shipments.id, s.id) }))!.cancelledAt).toBeNull();
    mode = "ok";
    await sh.cancelShipment(s.id);
    const after = (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, s.id) }))!;
    expect(after.glsStatus).toBe("cancelled");
    expect(after.cancelledAt).not.toBeNull();
    expect(calls.filter((c) => c.url.includes("/shipments/cancel/")).map((c) => c.url.split("/").pop())).toEqual(expect.arrayContaining(s.glsTrackIds));
  });

  it("Mit Einwilligung: E-Mail + Telefon an GLS (und FlexDelivery, wenn eingeschaltet); Speditionsware nie als GLS-Paket", async () => {
    vi.stubGlobal("fetch", mock());
    await saveGlsSettings({ endpoint: "http://localhost:9/backend/rs", user: "2764200001", password: "", contactId: "276a45fkqM", flex: true });
    const id = await sh.createGlsShipment({ invoiceId, parcelsKg: [3.6], pick: null, notify: false, consent: true });
    const req = calls.at(-1)!.body as { Shipment: { Consignee: { Address: Record<string, string> }; Service?: { Service: { ServiceName: string } }[] } };
    expect(req.Shipment.Consignee.Address).toMatchObject({ eMail: expect.stringMatching(/^gls\d+@example\.com$/), MobilePhoneNumber: "+49 170 1234567" });
    expect(req.Shipment.Service).toEqual([{ Service: { ServiceName: "service_flexdelivery" } }]);
    expect((await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) }))!.glsContactConsent).toBe(true);
    await sh.cancelShipment(id);
    // Artikel ist Speditionsware (Möbel) → gar nicht erst bei GLS
    const pid = (await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) }))!.productId;
    await db.update(schema.products).set({ shippingClass: "FREIGHT" }).where(eq(schema.products.id, pid));
    const before = calls.length;
    await expect(sh.createGlsShipment({ invoiceId, parcelsKg: [3.6], pick: null, notify: false, consent: true })).rejects.toMatchObject({ code: "freight", detail: "Haarschneidemaschine" });
    expect(calls.length).toBe(before);
    await db.update(schema.products).set({ shippingClass: null }).where(eq(schema.products.id, pid));
    await saveGlsSettings({ endpoint: "http://localhost:9/backend/rs", user: "2764200001", password: "", contactId: "276a45fkqM", flex: false });
  });

  it("Abholung: nicht „zu versenden“, sondern „zur Abholung“; Bereit + Abgeholt", async () => {
    const orderId = `gid://shopify/Order/P${Date.now()}`;
    const [c] = await db.insert(schema.customers).values({ name: "Abholer", email: `pick${Date.now()}@example.com` }).returning();
    const draft = await saveInvoiceDraft({
      customerId: c.id, channel: "GENERAL_SHOP", discountBp: 0, notes: "", deliveryDate: "2026-11-13", retentionOfTitle: false, pricesGross: true, externalOrderId: orderId,
      taxOverride: { mode: "DOMESTIC", ossCountry: null },
      lines: [{ variantId, description: "Haarschneidemaschine", qty: 1, unitPriceCents: 5950, discountBp: 0, vatRateBp: 1900, externalLineId: "gid://shopify/LineItem/77" }],
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    expect((await sh.shopOrdersToShip()).map((x) => x.id)).toContain(draft);
    await db.update(schema.invoices).set({ deliveryMethod: "PICK_UP" }).where(eq(schema.invoices.id, draft));
    expect((await sh.shopOrdersToShip()).map((x) => x.id)).not.toContain(draft);
    expect((await sh.shopOrdersToPickUp()).map((x) => x.id)).toContain(draft);
    // Laden-Rechnung mit Abholung: bereit ohne Shop
    await db.update(schema.invoices).set({ deliveryMethod: "PICK_UP" }).where(eq(schema.invoices.id, invoiceId));
    expect(await sh.markPickupReady(invoiceId)).toEqual({ shop: "none", error: undefined });
    expect((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) }))!.pickupReadyAt).not.toBeNull();
    const pid = await sh.markPickedUp(invoiceId);
    expect((await db.query.shipments.findFirst({ where: eq(schema.shipments.id, pid) }))).toMatchObject({ carrier: "OTHER", carrierName: "Abholung", trackingNumbers: [] });
    expect((await sh.shippingStates([invoiceId])).get(invoiceId)).toBe("done");
    // Rechnung ohne Abholung: „bereit“ geht nicht
    await db.update(schema.invoices).set({ deliveryMethod: "" }).where(eq(schema.invoices.id, draft));
    await expect(sh.markPickupReady(draft)).rejects.toMatchObject({ code: "notPickup" });
  });

  it("Versand-Bestellung, Kunde holt doch selbst im Lager ab (19.11.2026): Teil + Hinweis, ohne E-Mail, Zahl am Menüpunkt", async () => {
    const orderId = `gid://shopify/Order/S${Date.now()}`;
    const [c] = await db.insert(schema.customers).values({ name: "Selbstabholer", email: `self${Date.now()}@example.com` }).returning();
    const draft = await saveInvoiceDraft({
      customerId: c.id, channel: "GENERAL_SHOP", discountBp: 0, notes: "", deliveryDate: "2026-11-19", retentionOfTitle: false, pricesGross: true, externalOrderId: orderId,
      taxOverride: { mode: "DOMESTIC", ossCountry: null },
      lines: [{ variantId, description: "Haarschneidemaschine", qty: 2, unitPriceCents: 5950, discountBp: 0, vatRateBp: 1900, externalLineId: "gid://shopify/LineItem/91" }],
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    const waiting = async () => {
      const [a, b, n] = await Promise.all([sh.shopOrdersToShip(), sh.shopOrdersToPickUp(), sh.shopOrdersWaitingCount()]);
      expect(n).toBe(a.length + b.length); // Zahl am Menüpunkt = Hinweise auf der Startseite
      return a.map((x) => x.id);
    };
    expect(await waiting()).toContain(draft);
    const line = (await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, draft)))[0];
    // erst 1 von 2 Stück mitgenommen, mit Hinweis
    const first = await sh.markPickedUp(draft, undefined, { pick: { [line.id]: 1 }, note: "mit eigenem Transporter" });
    const s1 = (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, first) }))!;
    expect(s1).toMatchObject({ carrier: "OTHER", carrierName: "Abholung", trackingNumbers: [], notifyCustomer: false, note: "mit eigenem Transporter", shopStatus: "pending" });
    expect(s1.items).toMatchObject([{ qty: 1, externalLineId: "gid://shopify/LineItem/91" }]);
    expect((await sh.shippingStates([draft])).get(draft)).toBe("partial");
    expect(await waiting()).toContain(draft); // 1 Stück noch offen
    // Rest mitgenommen → erledigt, nicht mehr „zu versenden“, in der Liste „Abgeholt“
    await sh.markPickedUp(draft);
    expect((await sh.shippingStates([draft])).get(draft)).toBe("done");
    expect(await waiting()).not.toContain(draft);
    expect((await sh.pickedUpInvoices([draft, invoiceId])).has(draft)).toBe(true);
    await expect(sh.markPickedUp(draft)).rejects.toMatchObject({ code: "nothingOpen" });
    // eine Sendung zurückgenommen → wieder offen; echte Sendung dazu → nicht mehr „nur abgeholt“
    await sh.cancelShipment(first);
    expect(await waiting()).toContain(draft);
    await sh.createShipment({ invoiceId: draft, carrier: "DHL", carrierName: "", trackingUrl: "", numbers: ["00340434161094042557"], notify: false, pick: null }, undefined);
    expect((await sh.pickedUpInvoices([draft])).has(draft)).toBe(false);
    expect(sh.isPickupShipment({ carrier: "OTHER", carrierName: "Abholung", trackingNumbers: [] })).toBe(true);
    expect(sh.isPickupShipment({ carrier: "OTHER", carrierName: "Abholung", trackingNumbers: ["X1"] })).toBe(false);
  });

  async function lineId() {
    return (await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)))[0].id;
  }
});
