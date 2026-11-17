import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import { buildImport, columnLabel, guessHeaderRow, guessMapping, importDate, importMoney, importVat, mappingFromParams } from "../src/lib/product-import";
import type { Sheet } from "../src/lib/sheet-read";

const sheet = (rows: string[][], images: Sheet["images"] = []): Sheet => ({ name: "S", rows, images });

describe("Artikel-Import: Spalten erkennen", () => {
  it("deutsche Lieferanten-Liste mit Titelzeile darüber", () => {
    const rows = [["Preisliste Herbst 2026"], [], ["Artikelbezeichnung", "EAN", "Art.-Nr.", "Kategorie", "Größe", "Farbe", "EK netto", "Großhandelspreis", "VK", "MwSt", "Menge", "MHD", "Gewicht", "Lieferant"]];
    const h = guessHeaderRow(rows);
    expect(h).toBe(2);
    expect(guessMapping(rows[h])).toEqual({ nameDe: 0, barcode: 1, sku: 2, category: 3, size: 4, color: 5, purchasePrice: 6, wholesalePrice: 7, retailPrice: 8, vat: 9, stock: 10, expiry: 11, weight: 12, supplier: 13 });
  });
  it("arabische und englische Spaltennamen, Name NL nicht als deutscher Name", () => {
    expect(guessMapping(["اسم المنتج", "الباركود", "سعر الجملة", "سعر جملة الجملة", "الكمية", "اللون"]))
      .toEqual({ nameDe: 0, barcode: 1, retailPrice: 2, wholesalePrice: 3, stock: 4, color: 5 });
    expect(guessMapping(["Name NL", "Name", "Barcode", "Price", "Qty"])).toEqual({ nameNl: 0, nameDe: 1, barcode: 2, retailPrice: 3, stock: 4 });
    expect(guessMapping(["Product name", "GTIN", "Cost price", "Reseller price", "Category"])).toEqual({ nameDe: 0, barcode: 1, purchasePrice: 2, wholesalePrice: 3, category: 4 });
  });
  it("Zuordnung aus dem Formular und Spaltennamen für die Auswahl", () => {
    const p = new URLSearchParams("m_nameDe=0&m_barcode=3&m_sku=&m_color=x");
    expect(mappingFromParams((k) => p.get(k))).toEqual({ nameDe: 0, barcode: 3 });
    expect(mappingFromParams(() => null)).toBeNull();
    expect(columnLabel(["Name", "EAN"], 1)).toBe("B · EAN");
    expect(columnLabel([], 27)).toBe("AB");
  });
});

describe("Artikel-Import: Werte lesen", () => {
  it("Beträge, MwSt., Datum", () => {
    expect(importMoney("12.5")).toBe(1250); // Excel-Zahl
    expect(importMoney("12,50 €")).toBe(1250);
    expect(importMoney("1.234,50")).toBe(123450);
    expect(importMoney("1234.567")).toBe(123457);
    expect(importMoney("")).toBe(0);
    expect(importMoney("12.345")).toBeNull(); // Tausender oder drei Nachkommastellen? → nachfragen statt raten
    expect(importMoney("abc")).toBeNull();
    expect(importVat("19")).toBe(1900); expect(importVat("7%")).toBe(700); expect(importVat("0.19")).toBe(1900); expect(importVat("")).toBe(1900);
    expect(importVat("16")).toBeNull();
    expect(importDate("31.12.2026")).toBe("2026-12-31"); expect(importDate("2026-12-31")).toBe("2026-12-31"); expect(importDate("1/2/27")).toBe("2027-02-01");
    expect(importDate("30.02.2026")).toBeNull(); expect(importDate("12/2026")).toBeNull();
  });

  it("Zeilen prüfen, Größen/Farben zu einem Artikel, Fotos aus der Zeile und per Dateiname", () => {
    const head = ["Name", "Barcode", "Art.-Nr.", "Größe", "VK", "MwSt", "Menge", "Gewicht"];
    const s = sheet([
      head,
      ["Haarwachs", "4006381333931", "", "150 ml", "12.5", "19", "10", "150 g"],
      ["Haarwachs", "4006381333948", "", "500 ml", "29,90", "19", "4", "0,5 kg"],
      ["Haarwachs", "4006381333955", "", "150 ml", "13", "19", "", ""], // gleiche Größe → doppelt
      ["Kamm", "4006381333931", "", "", "2", "", "", ""], // Barcode doppelt in der Datei
      ["", "1234567890128", "", "", "5", "", "", ""], // ohne Name
      ["Schere Profi", "", "SCH-1", "", "abc", "16", "1,5", ""], // Preis/Bestand kaputt, MwSt. unbekannt
      ["Umhang", "", "", "", "", "", "", ""], // ohne Barcode und Art.-Nr.
      ["Bürste", "4006381333962", "", "", "4,95", "7", "3", ""],
    ], [{ row: 1, col: 8, mime: "image/png", data: new Uint8Array([1]), name: "a.png" }]);
    const { rows, groups } = buildImport(s, 0, guessMapping(head), { photos: [{ name: "4006381333962.JPG" }, { name: "kamm.png" }] });
    expect(rows.map((r) => [r.row, r.errors, r.warnings])).toEqual([
      [2, [], []], [3, [], []], [4, ["dupVariant"], []], [5, ["dupBarcode"], []], [6, ["noName"], []],
      [7, ["badPrice", "badStock"], ["badVat"]], [8, ["noCode"], ["noPrice"]], [9, [], []],
    ]);
    // Haarwachs = ein Artikel mit 2 Größen, Art.-Nr. = erster Barcode
    const wachs = groups.find((g) => rows[g.rows[0]].nameDe === "Haarwachs")!;
    expect(wachs.rows.map((j) => rows[j].size)).toEqual(["150 ml", "500 ml"]);
    expect(wachs.sku).toBe("4006381333931");
    expect(rows[0]).toMatchObject({ retail: 1250, vatBp: 1900, stock: 10, weightGrams: 150, image: 0, first: true });
    expect(rows[1]).toMatchObject({ retail: 2990, weightGrams: 500, first: false, group: rows[0].group });
    expect(rows[7]).toMatchObject({ vatBp: 700, retail: 495, photo: 0 }); // Foto per Barcode
    expect(rows[3].photo).toBe(1); // Foto per Name
    expect(groups.find((g) => rows[g.rows[0]].nameDe === "Schere Profi")!.sku).toBe("SCH-1");
  });

  it("Artikel mit MHD: Zeile mit Bestand ohne MHD wird nicht importiert", () => {
    const { rows } = buildImport(sheet([["Name", "Barcode", "Größe", "Menge", "MHD"], ["Wachs", "11", "S", "5", "31.12.2027"], ["Wachs", "12", "M", "3", ""], ["Wachs", "13", "L", "", ""]]), 0, { nameDe: 0, barcode: 1, size: 2, stock: 3, expiry: 4 });
    expect(rows.map((r) => r.errors)).toEqual([[], ["noExpiry"], []]);
  });

  it("Brutto-Preise werden in netto umgerechnet", () => {
    const { rows } = buildImport(sheet([["Name", "Barcode", "Preis", "MwSt"], ["Kamm", "4006381333931", "29,90", "19"]]), 0, { nameDe: 0, barcode: 1, retailPrice: 2, vat: 3 }, { gross: true });
    expect(rows[0].retail).toBe(2513); // 29,90 € brutto → 25,13 € netto (wie im Shop)
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Artikel-Import mit Datenbank", () => {
  async function xlsx(rows: string[][], imageRow?: number): Promise<Uint8Array> {
    const z = new JSZip();
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const col = (c: number) => String.fromCharCode(65 + c);
    const body = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => `<c r="${col(c)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`).join("");
    z.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Liste" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    z.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
    z.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${body}</sheetData>${imageRow != null ? '<drawing r:id="rId1"/>' : ""}</worksheet>`);
    if (imageRow != null) {
      z.file("xl/worksheets/_rels/sheet1.xml.rels", `<Relationships><Relationship Id="rId1" Type="http://x/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
      z.file("xl/drawings/drawing1.xml", `<wsDr><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>${imageRow}</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:oneCellAnchor></wsDr>`);
      z.file("xl/drawings/_rels/drawing1.xml.rels", `<Relationships><Relationship Id="rId1" Type="image" Target="../media/image1.png"/></Relationships>`);
      z.file("xl/media/image1.png", await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer());
    }
    return z.generateAsync({ type: "uint8array" });
  }

  it("legt neue Artikel mit Größen, Preisen, Foto und Bestand an; vorhandene Barcodes bleiben unberührt; zweimal = nichts doppelt", async () => {
    const { db, schema } = await import("../src/db");
    const { eq, inArray } = await import("drizzle-orm");
    const { saveTempFile } = await import("../src/lib/temp-files");
    const { analyzeImport, runImport } = await import("../src/lib/product-import-db");
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    const uid = user.id;
    const n = String(Date.now()).slice(-7);
    // vorhandener Artikel mit Barcode X
    const [existingP] = await db.insert(schema.products).values({ sku: `IMP-EX-${n}`, nameDe: `Import vorhanden ${n}` }).returning({ id: schema.products.id });
    await db.insert(schema.variants).values({ productId: existingP.id, barcode: `IMPX${n}` });
    const rows = [
      ["Name", "Barcode", "Größe", "Großhandelspreis", "Einzelhandelspreis", "EK", "Menge", "Kategorie", "MHD"],
      [`Import Wachs ${n}`, `IMPA${n}`, "150 ml", "8,00", "12,50", "5,00", "10", `Import-Kat ${n}`, "31.12.2027"],
      [`Import Wachs ${n}`, `IMPB${n}`, "500 ml", "20,00", "29,90", "5,00", "2", `Import-Kat ${n}`, "30.06.2027"],
      [`Import vorhanden ${n}`, `IMPX${n}`, "", "1", "2", "", "5", "", ""],
      [`Import Fehler ${n}`, `IMPC${n}`, "", "abc", "", "", "", "", ""],
    ];
    const meta = await saveTempFile(uid, "liste.xlsx", await xlsx(rows, 1));
    const plan = await analyzeImport(uid, { fileId: meta.id });
    expect(plan.status).toEqual(["new", "new", "exists", "error"]);
    expect(plan.counts).toMatchObject({ products: 1, variants: 2, exists: 1, errors: 1, photos: 1, stock: 12 });

    const res = await runImport(uid, { fileId: meta.id, general: true, brand: false }, { prices: true, cost: true, stock: true });
    expect(res).toEqual({ created: 1, variants: 2, skipped: 2, photos: 1, stock: 12 });
    const [p] = await db.select().from(schema.products).where(eq(schema.products.sku, `IMPA${n}`));
    expect(p).toMatchObject({ nameDe: `Import Wachs ${n}`, wholesalePriceCents: 800, retailPriceCents: 1250, purchasePriceCents: 500, category: `Import-Kat ${n}`, tracksExpiry: true, inGeneralShop: true, inBrandShop: false });
    expect(p.imageFileId).toBeTruthy();
    const vs = await db.select().from(schema.variants).where(eq(schema.variants.productId, p.id));
    expect(vs.map((v) => [v.size, v.barcode, v.stockQty, v.wholesalePriceCents, v.retailPriceCents]).sort()).toEqual([
      ["150 ml", `IMPA${n}`, 10, null, null], ["500 ml", `IMPB${n}`, 2, 2000, 2990],
    ]);
    const batches = await db.select().from(schema.batches).where(inArray(schema.batches.variantId, vs.map((v) => v.id)));
    expect(batches.map((b) => [b.qtyReceived, b.unitCostCents, b.expiryDate]).sort()).toEqual([[10, 500, "2027-12-31"], [2, 500, "2027-06-30"]]);
    const [cat] = await db.select().from(schema.categories).where(eq(schema.categories.name, `Import-Kat ${n}`));
    expect(cat).toBeTruthy();
    // vorhandener Artikel unverändert
    const [ex] = await db.select().from(schema.variants).where(eq(schema.variants.barcode, `IMPX${n}`));
    expect(ex.stockQty).toBe(0);
    // noch einmal: alles schon da → nichts doppelt
    const again = await analyzeImport(uid, { fileId: meta.id });
    expect(again.status).toEqual(["exists", "exists", "exists", "error"]);
    await expect(runImport(uid, { fileId: meta.id, general: false, brand: false }, { prices: true, cost: true, stock: true })).rejects.toMatchObject({ code: "nothing" });
    // fremde Person sieht die Datei nicht
    await expect(analyzeImport("someone-else", { fileId: meta.id })).rejects.toMatchObject({ code: "fileGone" });
  });

  it("ohne Preis-/Bestandsrechte: Preise 0, kein Bestand", async () => {
    const { db, schema } = await import("../src/db");
    const { eq } = await import("drizzle-orm");
    const { saveTempFile } = await import("../src/lib/temp-files");
    const { runImport } = await import("../src/lib/product-import-db");
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    const n = String(Date.now()).slice(-7);
    const meta = await saveTempFile(user.id, "l.csv", new TextEncoder().encode(`Name;EAN;Preis;Menge\nImport Kamm ${n};IMPK${n};4,95;7\n`));
    const res = await runImport(user.id, { fileId: meta.id, general: false, brand: false }, { prices: false, cost: false, stock: false });
    expect(res).toMatchObject({ created: 1, stock: 0 });
    const [p] = await db.select().from(schema.products).where(eq(schema.products.sku, `IMPK${n}`));
    expect([p.retailPriceCents, p.wholesalePriceCents]).toEqual([0, 0]);
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.productId, p.id));
    expect(v.stockQty).toBe(0);
  });
});
