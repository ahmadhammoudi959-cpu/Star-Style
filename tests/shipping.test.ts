import { describe, expect, it } from "vitest";
import {
  carrierFromCompany, carrierLabel, checkNumbers, customUrlOk, normalizeTrackingNumber, planFulfillment, remapItems, resolveItems,
  shippingState, shopTrackingInput, trackingUrl, urlTemplate, type FoNode, type ShipLine,
} from "../src/lib/shipping";

// Versand mit Sendungsnummer (Wunsch Inhaber 12.11.2026)
describe("Nummern und Links", () => {
  it("Nummer vom Etikett: Leerzeichen weg, Großbuchstaben", () => {
    expect(normalizeTrackingNumber(" 0034 0434 1610 9404 2557 ")).toBe("00340434161094042557");
    expect(normalizeTrackingNumber("jjd00 0390 0071")).toBe("JJD0003900071");
  });
  it("Prüfen: Format, doppelt, fehlt (Spedition darf ohne), höchstens 20 Pakete", () => {
    expect(checkNumbers("DHL", ["00340434161094042557", " 0034 0434 1610 9404 2558"])).toEqual({ numbers: ["00340434161094042557", "00340434161094042558"], problem: null });
    expect(checkNumbers("DHL", ["", " "])).toMatchObject({ problem: "missing" });
    expect(checkNumbers("OTHER", [""])).toMatchObject({ problem: null, numbers: [] });
    expect(checkNumbers("DHL", ["123"])).toMatchObject({ problem: "format", bad: "123" });
    expect(checkNumbers("DHL", ["ABC/123456"])).toMatchObject({ problem: "format" });
    expect(checkNumbers("DPD", ["01234567890123", "0123 4567 8901 23"])).toMatchObject({ problem: "duplicate", bad: "01234567890123" });
    expect(checkNumbers("GLS", Array.from({ length: 21 }, (_, i) => `ZZ${100000 + i}`))).toMatchObject({ problem: "tooMany" });
  });
  it("Links je Versanddienst; Spedition mit eigenem Link ({n} = Nummer)", () => {
    expect(trackingUrl("DHL", "00340434161094042557")).toBe("https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042557");
    expect(trackingUrl("DPD", "01234567890123")).toBe("https://tracking.dpd.de/status/de_DE/parcel/01234567890123");
    expect(trackingUrl("UPS", "1Z999AA10123456784")).toContain("tracknum=1Z999AA10123456784");
    expect(trackingUrl("OTHER", "A-77", "https://spedition.example/track?nr={n}")).toBe("https://spedition.example/track?nr=A-77");
    expect(trackingUrl("OTHER", "A-77", "https://spedition.example/sendungen")).toBe("https://spedition.example/sendungen");
    expect(trackingUrl("OTHER", "A-77", "")).toBeNull();
    expect(customUrlOk("")).toBe(true);
    expect(customUrlOk("https://x.example/t?n={n}")).toBe(true);
    expect(customUrlOk("http://x.example")).toBe(false);
    expect(customUrlOk("javascript:alert(1)")).toBe(false);
  });
  it("an Shopify: Firma + Nummern + Links; Spedition ohne Nummer nur Name/Link", () => {
    expect(shopTrackingInput({ carrier: "DHL", carrierName: "", trackingNumbers: ["00340434161094042557", "00340434161094042558"], trackingUrl: "" })).toEqual({
      company: "DHL", numbers: ["00340434161094042557", "00340434161094042558"],
      urls: ["https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042557", "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094042558"],
    });
    expect(shopTrackingInput({ carrier: "HERMES", carrierName: "", trackingNumbers: ["H1001234567890"], trackingUrl: "" })).toMatchObject({ company: "Hermes" });
    expect(shopTrackingInput({ carrier: "OTHER", carrierName: " Möbel Express ", trackingNumbers: [], trackingUrl: "https://moebel.example/t" })).toEqual({ company: "Möbel Express", url: "https://moebel.example/t" });
    expect(shopTrackingInput({ carrier: "OTHER", carrierName: "Möbel Express", trackingNumbers: ["AB-123456"], trackingUrl: "" })).toEqual({ company: "Möbel Express", numbers: ["AB-123456"] });
    expect(carrierLabel("HERMES")).toBe("Hermes");
  });
  it("im Shopify-Admin versendet → unser Versanddienst, sonst Spedition mit Namen; Link als Vorlage", () => {
    expect(carrierFromCompany("DHL")).toEqual({ carrier: "DHL", carrierName: "" });
    expect(carrierFromCompany("gls")).toEqual({ carrier: "GLS", carrierName: "" });
    expect(carrierFromCompany("DHL Express")).toEqual({ carrier: "OTHER", carrierName: "DHL Express" });
    expect(carrierFromCompany(null)).toEqual({ carrier: "OTHER", carrierName: "" });
    expect(urlTemplate("https://x.example/t?id=JJD123", "JJD123")).toBe("https://x.example/t?id={n}");
    expect(urlTemplate("https://x.example/t", "JJD123")).toBe("https://x.example/t");
  });
});

const L = (id: string, qty: number, o: Partial<ShipLine> = {}): ShipLine => ({ id, qty, variantId: `v-${id}`, externalLineId: null, description: `Artikel ${id}`, ...o });

describe("Was ist schon verschickt?", () => {
  const shopLines = [
    L("a", 3, { externalLineId: "gid://shopify/LineItem/11" }),
    L("b", 1, { externalLineId: "gid://shopify/LineItem/12", variantId: null }), // im Shop, aber nicht zugeordnet → trotzdem Ware
    L("s", 1, { externalLineId: "shipping", variantId: null, description: "Versand" }), // Versandkosten
  ];
  it("nichts / teilweise / alles; stornierte Sendung zählt nicht", () => {
    expect(shippingState(shopLines, []).state).toBe("none");
    const part = [{ items: [{ lineId: "a", externalLineId: "gid://shopify/LineItem/11", variantId: "v-a", description: "", qty: 2 }], cancelledAt: null }];
    expect(shippingState(shopLines, part)).toMatchObject({ state: "partial", shippedUnits: 2, totalUnits: 4 });
    expect(shippingState(shopLines, part).open.map((o) => [o.line.id, o.qty])).toEqual([["a", 1], ["b", 1]]);
    const all = resolveItems(shopLines, part, null);
    expect(all.items.map((i) => [i.lineId, i.qty])).toEqual([["a", 1], ["b", 1]]);
    expect(shippingState(shopLines, [...part, { items: all.items, cancelledAt: null }]).state).toBe("done");
    expect(shippingState(shopLines, [...part, { items: all.items, cancelledAt: new Date() }]).state).toBe("partial");
  });
  it("nach einer Korrektur (neue Positions-IDs) über die Shopify-Position bzw. den Artikel zugeordnet", () => {
    const newLines = [L("a2", 2, { externalLineId: "gid://shopify/LineItem/11", variantId: "v-a" }), L("b2", 1, { externalLineId: "gid://shopify/LineItem/12", variantId: null })];
    const old = [{ items: [{ lineId: "a", externalLineId: "gid://shopify/LineItem/11", variantId: "v-a", description: "", qty: 3 }], cancelledAt: null }];
    expect(shippingState(newLines, old)).toMatchObject({ state: "partial", shippedUnits: 2 }); // nie mehr als die Position hat
    expect(remapItems(old[0].items, newLines)[0].lineId).toBe("a2");
    const store = [L("x9", 5)];
    expect(remapItems([{ lineId: "x", externalLineId: null, variantId: "v-x", description: "Artikel x", qty: 5 }], [{ ...store[0], variantId: "v-x", description: "Artikel x" }])[0].lineId).toBe("x9");
  });
  it("Auswahl: Teilmengen, zu viel, leer, schon alles verschickt; Rechnung nur mit Freitext", () => {
    expect(resolveItems(shopLines, [], { a: 2 }).items.map((i) => [i.lineId, i.qty])).toEqual([["a", 2]]);
    expect(resolveItems(shopLines, [], { a: 4 }).problem).toBe("qtyTooHigh");
    expect(resolveItems(shopLines, [], { s: 1 }).problem).toBe("qtyTooHigh"); // Versandkosten sind keine Ware
    expect(resolveItems(shopLines, [], { a: 0, b: 0 }).problem).toBe("empty");
    const done = [{ items: resolveItems(shopLines, [], null).items, cancelledAt: null }];
    expect(resolveItems(shopLines, done, null).problem).toBe("nothingOpen");
    const text = [L("t", 1, { variantId: null, description: "Montage" })];
    expect(shippingState(text, []).state).toBe("nothing");
    expect(resolveItems(text, [], null)).toEqual({ items: [], problem: null });
    expect(shippingState(text, [{ items: [], cancelledAt: null }]).state).toBe("done");
  });
});

describe("Shopify: Sendung → Fulfillment-Positionen", () => {
  const fo = (id: string, loc: string, lines: [string, string, number][], actions = ["CREATE_FULFILLMENT"]): FoNode =>
    ({ id, locationId: loc, actions, lines: lines.map(([lid, li, remaining]) => ({ id: lid, lineItemId: li, remaining })) });
  it("verteilt auf offene Positionen, ein Fulfillment je Lagerort, Rest = nicht mehr offen", () => {
    const fos = [
      fo("FO1", "L1", [["F1", "gid://shopify/LineItem/11", 2], ["F2", "gid://shopify/LineItem/12", 1]]),
      fo("FO2", "L2", [["F3", "gid://shopify/LineItem/11", 1]]),
      fo("FO3", "L1", [["F4", "gid://shopify/LineItem/11", 5]], ["REQUEST_FULFILLMENT"]), // bei einem Dienstleister → nicht selbst versenden
    ];
    const r = planFulfillment(fos, [{ externalLineId: "gid://shopify/LineItem/11", qty: 2 }, { externalLineId: "gid://shopify/LineItem/11", qty: 1 }, { externalLineId: "gid://shopify/LineItem/12", qty: 2 }, { externalLineId: "shipping", qty: 1 }]);
    expect(r.groups).toEqual([
      { locationId: "L1", lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "FO1", fulfillmentOrderLineItems: [{ id: "F1", quantity: 2 }, { id: "F2", quantity: 1 }] }] },
      { locationId: "L2", lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "FO2", fulfillmentOrderLineItems: [{ id: "F3", quantity: 1 }] }] },
    ]);
    expect(r.missing).toEqual([{ externalLineId: "gid://shopify/LineItem/12", qty: 1 }]);
  });
  it("im Shop schon alles versendet → nichts zu tun", () => {
    const r = planFulfillment([fo("FO1", "L1", [["F1", "gid://shopify/LineItem/11", 0]])], [{ externalLineId: "gid://shopify/LineItem/11", qty: 1 }]);
    expect(r).toEqual({ groups: [], missing: [{ externalLineId: "gid://shopify/LineItem/11", qty: 1 }] });
  });
});
