import { describe, expect, it } from "vitest";
import { barcodeCandidates, checkDigitOk } from "../src/lib/barcode";

describe("Barcode-Scanner: Codes vergleichbar machen", () => {
  it("UPC-A ↔ EAN-13 mit führender 0, Leerzeichen weg", () => {
    expect(barcodeCandidates(" 4006381333931 ")).toEqual(["4006381333931"]);
    expect(barcodeCandidates("036000291452")).toEqual(["036000291452", "0036000291452"]);
    expect(barcodeCandidates("0036000291452")).toEqual(["0036000291452", "036000291452"]);
    expect(barcodeCandidates("HC-90-4 GOLD")).toEqual(["HC-90-4GOLD"]);
    expect(barcodeCandidates("   ")).toEqual([]);
  });

  it("Prüfziffer bei EAN/UPC (falsch gelesene Ziffer wird verworfen), andere Codes immer ok", () => {
    expect(checkDigitOk("4006381333931")).toBe(true);
    expect(checkDigitOk("4006381333932")).toBe(false);
    expect(checkDigitOk("036000291452")).toBe(true);
    expect(checkDigitOk("96385074")).toBe(true); // EAN-8
    expect(checkDigitOk("96385075")).toBe(false);
    expect(checkDigitOk("ABC-123")).toBe(true);
    expect(checkDigitOk("12345")).toBe(true);
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Barcode-Scanner: Artikel nachschlagen (Datenbank)", async () => {
  const { db, schema } = await import("../src/db");
  const { lookupCode } = await import("../src/lib/scan");
  const tag = String(Date.now()).slice(-7);

  it("findet die Variante über den Barcode: Bestand, verfügbar, MHD, Preise, Verkäufe; Art.-Nr. und UPC gehen auch", async () => {
    const [p] = await db.insert(schema.products).values({ sku: `SCAN-${tag}`, nameDe: `Wachs ${tag}`, category: "Pflege & Verbrauch", vatRateBp: 1900,
      wholesalePriceCents: 500, retailPriceCents: 800, tracksExpiry: true }).returning();
    const [a] = await db.insert(schema.variants).values({ productId: p.id, size: "100 ml", barcode: `0${tag}12345`.slice(0, 13), stockQty: 7, minStock: 10 }).returning();
    const [b] = await db.insert(schema.variants).values({ productId: p.id, size: "250 ml", barcode: `9${tag}54321`.slice(0, 13), stockQty: 3, retailPriceCents: 1200 }).returning();
    // Charge mit MHD, Verkäufe: 2 vor 5 Tagen, 4 vor 60 Tagen, Storno 1 vor 3 Tagen
    await db.insert(schema.batches).values([
      { variantId: a.id, expiryDate: "2027-01-31", unitCostCents: 300, qtyReceived: 5, qtyLeft: 4 },
      { variantId: a.id, expiryDate: "2027-06-30", unitCostCents: 300, qtyReceived: 3, qtyLeft: 3 },
      { variantId: a.id, expiryDate: "2026-01-01", unitCostCents: 300, qtyReceived: 2, qtyLeft: 0 },
    ]);
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    await db.insert(schema.stockMovements).values([
      { variantId: a.id, type: "SALE", qty: -2, refType: "invoice", refId: "x1", createdAt: ago(5) },
      { variantId: a.id, type: "SALE", qty: -4, refType: "invoice", refId: "x2", createdAt: ago(60) },
      { variantId: a.id, type: "CANCEL", qty: 1, refType: "invoice", refId: "x3", createdAt: ago(3) },
      { variantId: a.id, type: "WRITE_OFF", qty: -1, refType: "writeoff", refId: "w1", createdAt: ago(2) },
    ]);

    const r = await lookupCode(` ${a.barcode} `);
    if (!r.found) throw new Error("nicht gefunden");
    expect(r.matchedVariantId).toBe(a.id);
    expect(r.product).toMatchObject({ id: p.id, nameDe: `Wachs ${tag}`, category: "Pflege & Verbrauch", vatRateBp: 1900, active: true });
    const va = r.variants.find((x) => x.id === a.id)!, vb = r.variants.find((x) => x.id === b.id)!;
    expect(va).toMatchObject({ stock: 7, reserved: 0, available: 7, minStock: 10, nextExpiry: "2027-01-31", nextExpiryQty: 4,
      wholesaleCents: 500, retailCents: 800, sold30: 1, sold90: 5 });
    expect(va.lastSale).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vb).toMatchObject({ stock: 3, retailCents: 1200, sold30: 0, sold90: 0, lastSale: null, nextExpiry: null });

    // EAN-13 mit führender 0 auch als UPC-A (12 Ziffern) gescannt
    const upc = await lookupCode(a.barcode!.slice(1));
    expect(upc.found && upc.matchedVariantId).toBe(a.id);
    // Art.-Nr. (ohne Groß/klein) → Artikel, keine bestimmte Variante (zwei Größen)
    const bySku = await lookupCode(`scan-${tag}`);
    expect(bySku.found && bySku.product.id).toBe(p.id);
    expect(bySku.found && bySku.matchedVariantId).toBeNull();
    // unbekannt
    expect(await lookupCode(`77${tag}999`)).toEqual({ found: false, code: `77${tag}999` });
  });
});
